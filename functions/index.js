const { onRequest } = require("firebase-functions/v2/https");
const { defineSecret } = require("firebase-functions/params");
const sgMail = require("@sendgrid/mail");
const cors = require("cors");

// Define segredo para o Google Cloud Secret Manager caso seja utilizado em deploy de produção
const sendgridApiKey = defineSecret("SENDGRID_API_KEY");

// Lista de origens permitidas (CORS)
const allowedOrigins = [
    "https://roohts.com.br",
    "https://www.roohts.com.br",
    "https://roohts-institucional.web.app",
    "https://roohts-institucional.firebaseapp.com"
];

const corsHandler = cors({
    origin: (origin, callback) => {
        // Permite requisições sem origin (como rewrites locais do Firebase Hosting ou chamadas diretas)
        if (!origin) return callback(null, true);
        
        // Permite origens oficiais ou desenvolvimento local
        if (
            allowedOrigins.includes(origin) ||
            /^http:\/\/localhost(:\d+)?$/.test(origin) ||
            /^http:\/\/127\.0\.0\.1(:\d+)?$/.test(origin)
        ) {
            return callback(null, true);
        }
        
        return callback(new Error("Origem não autorizada por política de CORS"));
    }
});

// Rate limiting simples por IP (máximo 5 requisições a cada 10 minutos por IP)
const rateLimitMap = new Map();
const RATE_LIMIT_WINDOW_MS = 10 * 60 * 1000;
const MAX_REQUESTS_PER_WINDOW = 5;

function isRateLimited(ip) {
    if (!ip) return false;
    const now = Date.now();
    const record = rateLimitMap.get(ip) || [];
    const recent = record.filter(time => now - time < RATE_LIMIT_WINDOW_MS);
    
    if (recent.length >= MAX_REQUESTS_PER_WINDOW) {
        return true;
    }
    
    recent.push(now);
    rateLimitMap.set(ip, recent);
    
    // Limpeza periódica de memória
    if (rateLimitMap.size > 1000) {
        for (const [key, times] of rateLimitMap.entries()) {
            if (times.every(t => now - t >= RATE_LIMIT_WINDOW_MS)) {
                rateLimitMap.delete(key);
            }
        }
    }
    return false;
}

// Sanitização de entradas contra CRLF Injection e ataques DoS por carga excessiva
function sanitizeSingleLine(val, maxLength = 100) {
    if (typeof val !== "string") return "";
    return val.replace(/[\r\n\t]/g, " ").trim().slice(0, maxLength);
}

function sanitizeMultiLine(val, maxLength = 5000) {
    if (typeof val !== "string") return "";
    return val.replace(/\r\n/g, "\n").slice(0, maxLength).trim();
}

exports.enviarContato = onRequest(
    { 
        secrets: [sendgridApiKey],
        maxInstances: 10
    },
    (req, res) => {
        corsHandler(req, res, async (err) => {
            if (err) {
                return res.status(403).json({ error: "Acesso não autorizado por CORS." });
            }

            // Permitir apenas o método POST
            if (req.method !== "POST") {
                return res.status(405).json({ error: "Método não permitido" });
            }

            // Rate limiting baseado no IP do cliente
            const clientIp = req.headers["x-forwarded-for"] || req.socket.remoteAddress || "unknown";
            if (isRateLimited(clientIp)) {
                return res.status(429).json({ error: "Muitas tentativas de envio. Por favor, aguarde alguns minutos." });
            }

            const body = req.body || {};

            // Honeypot anti-bot: se o campo oculto estiver preenchido, encerra sem disparar e-mail
            if (body.website_trap || body._gotcha) {
                return res.status(200).json({ success: true, message: "E-mail enviado com sucesso!" });
            }

            // Obtenção e sanitização dos campos
            const nome = sanitizeSingleLine(body.nome, 100);
            const sobrenome = sanitizeSingleLine(body.sobrenome, 100);
            const empresa = sanitizeSingleLine(body.empresa, 100);
            const cargo = sanitizeSingleLine(body.cargo, 100);
            const emailRaw = typeof body.email === "string" ? body.email.trim() : "";
            const mensagem = sanitizeMultiLine(body.mensagem, 5000);

            // Validação de campos obrigatórios
            if (!nome || !emailRaw || !mensagem) {
                return res.status(400).json({ error: "Preencha todos os campos obrigatórios." });
            }

            // Validação rigorosa de formato de e-mail (RFC simplificado)
            const emailRegex = /^[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)+$/;
            if (!emailRegex.test(emailRaw) || emailRaw.length > 254) {
                return res.status(400).json({ error: "Endereço de e-mail inválido." });
            }

            // Obtenção segura da API Key do SendGrid a partir de variáveis de ambiente ou Secret Manager
            const apiKey = process.env.SENDGRID_API_KEY || (sendgridApiKey && typeof sendgridApiKey.value === "function" ? sendgridApiKey.value() : "");

            if (!apiKey) {
                console.error("ERRO: SENDGRID_API_KEY não foi configurada nas variáveis de ambiente!");
                return res.status(500).json({ error: "Serviço de e-mail temporariamente indisponível." });
            }

            sgMail.setApiKey(apiKey);

            const toEmail = process.env.CONTACT_TO_EMAIL || "contato@roohts.com.br";
            const fromEmail = process.env.CONTACT_FROM_EMAIL || "roohts@roohts.com.br";

            const msg = {
                to: toEmail,
                from: fromEmail,
                replyTo: emailRaw,
                subject: `Contato Via Site - ${empresa || "Sem Empresa"}`,
                text: `Nome: ${nome}${sobrenome ? " " + sobrenome : ""}\nCargo: ${cargo || "-"}\nEmail: ${emailRaw}\n\nEmpresa: ${empresa || "-"}\n\nMensagem:\n${mensagem}`
            };

            try {
                await sgMail.send(msg);
                return res.status(200).json({ success: true, message: "E-mail enviado com sucesso!" });
            } catch (error) {
                // Registra detalhes sensíveis apenas nos logs protegidos do servidor
                console.error("Erro ao enviar e-mail via SendGrid:", error);
                if (error.response && error.response.body) {
                    console.error("Detalhes SendGrid API:", JSON.stringify(error.response.body));
                }
                
                // Retorna resposta limpa ao cliente sem vazar stack trace ou detalhes internos
                return res.status(500).json({ error: "Ocorreu um erro ao enviar sua mensagem. Tente novamente mais tarde." });
            }
        });
    }
);
