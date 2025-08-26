import { chromium } from 'playwright';
import express from 'express';
import cors from 'cors';
import nodemailer from 'nodemailer';
import dotenv from 'dotenv';
import ejs from 'ejs';
import { promisify } from 'util';
import { exec } from 'child_process';
import { promises as fs } from 'fs';
import path from 'path';
import crypto from 'crypto';

dotenv.config();

// Fonction utilitaire pour vérifier l'existence d'un exécutable
async function execExists(cmd) {
    const execAsync = promisify(exec);
    try {
        await execAsync(`which ${cmd}`);
        return true;
    } catch (e) {
        try {
            // Essayer avec --version
            await execAsync(`${cmd} --version`);
            return true;
        } catch (e2) {
            return false;
        }
    }
}

// Configuration Playwright
const isProd = process.env.NODE_ENV === 'production';

async function findChromiumExecutable() {
    const candidates = [];
    if (process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH) candidates.push(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH);
    if (process.env.CHROME_BIN) candidates.push(process.env.CHROME_BIN);
    // Emplacements courants sur Linux (Render et autres distros)
    candidates.push('/usr/bin/chromium');
    candidates.push('/usr/bin/chromium-browser');
    candidates.push('/usr/bin/google-chrome');
    candidates.push('/usr/bin/google-chrome-stable');
    
    console.log('Candidats Chromium détectés ->', candidates.filter(Boolean));
    
    for (const c of candidates) {
        if (!c) continue;
        try {
            const ok = await execExists(c);
            if (ok) {
                console.log('Candidat Chromium OK ->', c);
                // S'assurer que les variables d'environnement reflètent le chemin détecté
                process.env.CHROME_BIN = c;
                process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH = c;
                return c;
            }
        } catch (e) {
            // Continuer au candidat suivant
        }
    }

    // En dernier recours, essayer executablePath() de Playwright
    try {
        const pwPath = await chromium.executablePath();
        if (pwPath) {
            console.log('Utilisation du executablePath reporté par Playwright ->', pwPath);
            process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH = pwPath;
            process.env.CHROME_BIN = pwPath;
            return pwPath;
        }
    } catch (e) {
        // ignorer
    }

    console.warn('Aucun exécutable chromium détecté depuis les candidats ou le bundle Playwright');
    return undefined;
}

let playwrightConfig = {
    args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-accelerated-2d-canvas',
        '--disable-gpu',
        '--disable-software-rasterizer',
        '--disable-background-timer-throttling',
        '--disable-backgrounding-occluded-windows',
        '--disable-renderer-backgrounding'
    ],
    headless: true,
    executablePath: undefined,
    chromiumSandbox: false
};

// Configuration des tokens de téléchargement
const DOWNLOAD_TOKEN_SECRET = process.env.DOWNLOAD_TOKEN_SECRET || process.env.ENCRYPTION_KEY || 'dev-download-secret';
const DOWNLOAD_TOKEN_TTL = Number(process.env.DOWNLOAD_TOKEN_TTL_SECONDS || process.env.DOWNLOAD_TOKEN_TTL || 60 * 60);

// Protection contre les demandes en double
const DUPLICATE_WINDOW_SECONDS = Number(process.env.DUPLICATE_WINDOW_SECONDS || 15);
const recentRequests = new Map();
const sentRecords = new Map();
const sentRecipients = new Map();

// Nettoyage périodique
setInterval(() => {
    const now = Math.floor(Date.now() / 1000);
    for (const [sig, ts] of recentRequests.entries()) {
        if (now - ts > DUPLICATE_WINDOW_SECONDS) recentRequests.delete(sig);
    }
    for (const [sig, ts] of sentRecords.entries()) {
        if (now - ts > DUPLICATE_WINDOW_SECONDS) sentRecords.delete(sig);
    }
    for (const [sig, set] of sentRecipients.entries()) {
        if (!sentRecords.has(sig)) {
            sentRecipients.delete(sig);
        }
    }
}, 60 * 1000);

// Fonctions utilitaires
function base64UrlEncode(input) {
    return Buffer.from(input).toString('base64').replace(/=+$/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}

function base64UrlDecode(input) {
    input = input.replace(/-/g, '+').replace(/_/g, '/');
    while (input.length % 4) input += '=';
    return Buffer.from(input, 'base64').toString();
}

function stableStringify(obj) {
    const seen = new WeakSet();
    function canonicalize(value) {
        if (value && typeof value === 'object') {
            if (seen.has(value)) return;
            seen.add(value);
            if (Array.isArray(value)) {
                return value.map(canonicalize);
            }
            const keys = Object.keys(value).sort();
            const out = {};
            for (const k of keys) {
                out[k] = canonicalize(value[k]);
            }
            return out;
        }
        return value;
    }
    return JSON.stringify(canonicalize(obj));
}

function signDownloadToken(payloadObj) {
    const payload = JSON.stringify(payloadObj);
    const payloadB64 = base64UrlEncode(payload);
    const mac = crypto.createHmac('sha256', DOWNLOAD_TOKEN_SECRET).update(payloadB64).digest('base64').replace(/=+$/g, '').replace(/\+/g, '-').replace(/\//g, '_');
    return `${payloadB64}.${mac}`;
}

function verifyDownloadToken(token) {
    try {
        const parts = token.split('.');
        if (parts.length !== 2) return null;
        const [payloadB64, mac] = parts;
        const expectedMac = crypto.createHmac('sha256', DOWNLOAD_TOKEN_SECRET).update(payloadB64).digest('base64').replace(/=+$/g, '').replace(/\+/g, '-').replace(/\//g, '_');
        const a = Buffer.from(mac);
        const b = Buffer.from(expectedMac);
        if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
        const payloadJson = base64UrlDecode(payloadB64);
        const payload = JSON.parse(payloadJson);
        const now = Math.floor(Date.now() / 1000);
        if (!payload.exp || payload.exp < now) return null;
        return payload;
    } catch (e) {
        return null;
    }
}

const app = express();

// Configuration CORS
const configuredFrontendOrigin = (process.env.FRONTEND_ORIGIN || '').toString().trim() || undefined;
const allowedOrigins = new Set([
    'http://localhost:5173',
    'http://localhost:5174',
    'http://localhost:4173',
    'http://localhost:4174',
    'http://127.0.0.1:5173',
    'http://127.0.0.1:4173',
    'https://bedoui-frontend.onrender.com',
    'https://bedoui-backend.onrender.com',
    'https://backend-bedoui.onrender.com',
    'https://bedouistoreproducts.vercel.app'
]);

if (configuredFrontendOrigin) allowedOrigins.add(configuredFrontendOrigin);
console.log('Origines CORS autorisées ->', Array.from(allowedOrigins));

app.use(cors({
    origin: function (origin, callback) {
        if (!origin) return callback(null, true);

        const isRender = origin.includes('.onrender.com');
        const isVercel = origin.includes('.vercel.app');
        const isLocalhost = /^https?:\/\/localhost(?::\d+)?$/.test(origin);
        const isPrivateIp = /^https?:\/\/(?:127\.0\.0\.1|10\.\d{1,3}\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3}|172\.(?:1[6-9]|2[0-9]|3[0-1])\.\d{1,3}\.\d{1,3})(?::\d+)?$/.test(origin);

        if (isRender || isVercel) return callback(null, true);
        if (process.env.NODE_ENV !== 'production' && (isLocalhost || isPrivateIp)) return callback(null, true);
        if (allowedOrigins.has(origin)) return callback(null, true);

        console.log('Origine CORS bloquée:', origin);
        return callback(new Error('Non autorisé par CORS'));
    },
    credentials: true
}));

app.use(express.json({ limit: '2mb' }));

// Route racine
app.get('/', (req, res) => {
    res.json({
        name: 'Bedoui API',
        version: '1.0.0',
        status: 'running',
        timestamp: new Date().toISOString(),
        endpoints: [
            '/health',
            '/send-quote',
            '/download-devis/:name'
        ]
    });
});

// Middleware API Key (trim values to avoid trailing whitespace/newline mismatches)
const apiKey = (process.env.API_KEY || process.env.VITE_API_KEY || '').toString().trim();
app.use('/send-quote', (req, res, next) => {
    const rawClientKey = req.headers['x-api-key'] || '';
    const clientKey = rawClientKey.toString().trim();
    if (!apiKey) {
        console.error('❌ VARIABLE API_KEY NON CONFIGURÉE');
        return res.status(500).json({ 
            success: false, 
            error: 'Configuration serveur manquante',
            message: 'La clé API n\'est pas configurée sur le serveur'
        });
    }
    if (clientKey !== apiKey) {
        const masked = clientKey ? `${clientKey.slice(0,6)}...` : '(empty)';
        console.warn('Clé API invalide reçue (masked):', masked);
        return res.status(401).json({ 
            success: false, 
            error: 'Non autorisé: Clé API invalide ou manquante.',
            message: 'Veuillez vérifier la configuration de votre clé API.'
        });
    }
    next();
});

// Route principale pour l'envoi de devis
app.post('/send-quote', async (req, res) => {
    try {
        console.log('🔍 Début du processus de génération de devis');

        // Normaliser / trim des variables d'environnement SMTP pour éviter les \n/espaces
        const SMTP_HOST = (process.env.SMTP_HOST || '').toString().trim();
        const SMTP_PORT = (process.env.SMTP_PORT || '').toString().trim();
        const SMTP_USER = (process.env.SMTP_USER || '').toString().trim();
        const SMTP_PASS = (process.env.SMTP_PASS || '').toString().trim();
        const RECEIVER_EMAIL = (process.env.RECEIVER_EMAIL || '').toString().trim();

        console.log('📧 Configuration SMTP:', {
            host: SMTP_HOST || '(non configuré)',
            port: SMTP_PORT || '(non configuré)',
            user: SMTP_USER ? 'CONFIGURÉ' : '(non configuré)',
            pass: SMTP_PASS ? 'CONFIGURÉ' : '(non configuré)'
        });

        // Vérification de la configuration SMTP
        
        if (!SMTP_HOST || !SMTP_USER || !SMTP_PASS) {
            console.error('❌ Configuration SMTP manquante');
            return res.status(500).json({
                success: false,
                error: 'Configuration SMTP manquante sur le serveur',
                missing: {
                    host: !SMTP_HOST,
                    user: !SMTP_USER,
                    pass: !SMTP_PASS
                }
            });
        }

        if (!RECEIVER_EMAIL) {
            console.error('❌ RECEIVER_EMAIL non configuré');
            return res.status(500).json({
                success: false,
                error: 'Email destinataire non configuré'
            });
        }
        
        const adminEmails = RECEIVER_EMAIL.split(',').map(email => email.trim()).filter(Boolean);
        console.log('👥 Emails admin:', adminEmails);

        // Détection de doublons
        const bodyString = stableStringify(req.body || {});
        const bodySig = crypto.createHmac('sha256', DOWNLOAD_TOKEN_SECRET).update(bodyString).digest('hex');
        const now = Math.floor(Date.now() / 1000);
        const prev = recentRequests.get(bodySig);
        
        if (prev && now - prev < DUPLICATE_WINDOW_SECONDS) {
            console.log('Demande en double ignorée (dans la fenêtre). Signature:', bodySig);
            return res.status(202).json({ success: true, duplicate: true, message: 'Demande en double ignorée.' });
        }

        const alreadySent = sentRecords.get(bodySig);
        if (alreadySent && now - alreadySent < DUPLICATE_WINDOW_SECONDS) {
            console.log('Demande en double ignorée (déjà traitée). Signature:', bodySig);
            return res.status(202).json({ success: true, duplicate: true, message: 'Demande déjà traitée.' });
        }

        recentRequests.set(bodySig, now);

        const { name, email, phone, company, message, products } = req.body;

        // Validation des données
        if (!name || !email || !phone || !products || !Array.isArray(products) || products.length === 0) {
            return res.status(400).json({ 
                success: false, 
                error: 'Champs requis manquants ou produits vides.' 
            });
        }

        // Calcul du prix total
        const totalPrice = products.reduce((sum, item) => {
            let itemTotal = 0;
            if (item && typeof item.totalPrice === 'number') {
                itemTotal = item.totalPrice;
            } else if (item && item.product) {
                const qty = Number(item.quantity) || 0;
                const price = Number(item.product.price) || 0;
                itemTotal = qty * price;
            }
            return sum + (isNaN(itemTotal) ? 0 : itemTotal);
        }, 0);

        // Configuration Nodemailer (utiliser createTransport)
        const transporter = nodemailer.createTransport({
            host: SMTP_HOST,
            port: Number(SMTP_PORT) || 587,
            secure: String(SMTP_PORT) === '465',
            auth: SMTP_USER && SMTP_PASS ? { user: SMTP_USER, pass: SMTP_PASS } : undefined,
            tls: { rejectUnauthorized: false }
        });

        // Vérification de la connexion SMTP
        try {
            await transporter.verify();
            console.log('✅ Connexion SMTP vérifiée avec succès');
        } catch (smtpError) {
            console.error('❌ Erreur de connexion SMTP:', smtpError);
            return res.status(500).json({
                success: false,
                error: 'Erreur de configuration email',
                details: isProd ? 'Erreur de configuration serveur' : smtpError.message
            });
        }

        // Template email HTML
        const emailTemplate = `
        <!DOCTYPE html>
        <html lang="fr">
        <head>
            <meta charset="UTF-8">
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <title>Nouvelle demande de devis</title>
            <style>
                body { margin: 0; padding: 0; font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; background-color: #f8f9fa; }
                .container { max-width: 600px; margin: 0 auto; background-color: #ffffff; }
                .header { background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); color: white; padding: 30px; text-align: center; }
                .header h1 { margin: 0; font-size: 28px; font-weight: 300; }
                .content { padding: 30px; }
                .section { margin-bottom: 25px; }
                .section-title { color: #2c3e50; font-size: 18px; font-weight: 600; margin-bottom: 15px; border-bottom: 2px solid #3498db; padding-bottom: 5px; }
                .info-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 15px; margin-bottom: 20px; }
                .info-item { background-color: #f8f9fa; padding: 15px; border-radius: 8px; border-left: 4px solid #3498db; }
                .info-label { font-weight: 600; color: #2c3e50; margin-bottom: 5px; }
                .info-value { color: #34495e; }
                .products-table { width: 100%; border-collapse: collapse; margin-top: 15px; }
                .products-table th { background-color: #3498db; color: white; padding: 12px; text-align: left; }
                .products-table td { padding: 12px; border-bottom: 1px solid #ecf0f1; }
                .products-table tr:nth-child(even) { background-color: #f8f9fa; }
                .total-row { background-color: #e8f4fd !important; font-weight: 600; }
                .message-box { background-color: #f8f9fa; padding: 20px; border-radius: 8px; border-left: 4px solid #2ecc71; margin: 20px 0; }
                .footer { background-color: #2c3e50; color: white; padding: 20px; text-align: center; }
                .footer p { margin: 5px 0; }
                .highlight { color: #3498db; font-weight: 600; }
                @media (max-width: 600px) {
                    .info-grid { grid-template-columns: 1fr; }
                    .content { padding: 20px; }
                }
            </style>
        </head>
        <body>
            <div class="container">
                <div class="header">
                    <h1>📋 Nouvelle Demande de Devis</h1>
                    <p style="margin: 10px 0 0 0; opacity: 0.9;">Reçue le ${new Date().toLocaleDateString('fr-FR', {
                        weekday: 'long',
                        year: 'numeric',
                        month: 'long',
                        day: 'numeric',
                        hour: '2-digit',
                        minute: '2-digit'
                    })}</p>
                </div>

                <div class="content">
                    <div class="section">
                        <div class="section-title">👤 Informations Client</div>
                        <div class="info-grid">
                            <div class="info-item">
                                <div class="info-label">Nom et Prénom</div>
                                <div class="info-value">${name}</div>
                            </div>
                            <div class="info-item">
                                <div class="info-label">Email</div>
                                <div class="info-value"><a href="mailto:${email}" style="color: #3498db; text-decoration: none;">${email}</a></div>
                            </div>
                            <div class="info-item">
                                <div class="info-label">Téléphone</div>
                                <div class="info-value"><a href="tel:${phone}" style="color: #3498db; text-decoration: none;">${phone}</a></div>
                            </div>
                            ${company ? `
                            <div class="info-item">
                                <div class="info-label">Société</div>
                                <div class="info-value">${company}</div>
                            </div>
                            ` : ''}
                        </div>
                    </div>

                    <div class="section">
                        <div class="section-title">🛍️ Produits Demandés</div>
                        <table class="products-table">
                            <thead>
                                <tr>
                                    <th>Produit</th>
                                    <th>Quantité</th>
                                    <th>Prix Unitaire</th>
                                    <th>Total</th>
                                </tr>
                            </thead>
                            <tbody>
                                ${products.map(item => `
                                    <tr>
                                        <td><strong>${item.product.name}</strong></td>
                                        <td>${item.quantity}</td>
                                        <td>${item.product.price.toLocaleString()} TND</td>
                                        <td><span class="highlight">${item.totalPrice.toLocaleString()} TND</span></td>
                                    </tr>
                                `).join('')}
                                <tr class="total-row">
                                    <td colspan="3"><strong>Total Estimé</strong></td>
                                    <td><strong class="highlight">${totalPrice.toLocaleString()} TND</strong></td>
                                </tr>
                            </tbody>
                        </table>
                    </div>

                    ${message ? `
                    <div class="section">
                        <div class="section-title">💬 Message du Client</div>
                        <div class="message-box">
                            ${message.replace(/\n/g, '<br>')}
                        </div>
                    </div>
                    ` : ''}

                    <div class="section">
                        <div style="background-color: #e8f4fd; padding: 20px; border-radius: 8px; border-left: 4px solid #3498db;">
                            <h3 style="margin: 0 0 10px 0; color: #2c3e50;">⏰ Prochaines Étapes</h3>
                            <ul style="margin: 0; padding-left: 20px; color: #34495e;">
                                <li>Analyser la demande et vérifier la disponibilité des produits</li>
                                <li>Préparer un devis personnalisé avec les meilleures conditions</li>
                                <li>Contacter le client dans les 24h maximum</li>
                                <li>Proposer des alternatives si nécessaire</li>
                            </ul>
                        </div>
                    </div>
                </div>

                <div class="footer">
                    <p><strong>🏢 Système de Gestion des Devis</strong></p>
                    <p>Email automatique - Ne pas répondre directement</p>
                    <p style="font-size: 12px; opacity: 0.8;">Contactez directement le client via les coordonnées fournies ci-dessus</p>
                </div>
                <!-- PDF_BUTTON_PLACEHOLDER -->
            </div>
        </body>
        </html>
        `;

        // Génération du PDF
        console.log('🎭 Démarrage de la génération PDF');
        const templatePath = path.join(process.cwd(), process.env.PDF_TEMPLATE_PATH || 'templates/devis-pdf.ejs');
        
        // Vérification de l'existence du template
        try {
            await fs.access(templatePath);
            console.log('✅ Template PDF trouvé:', templatePath);
        } catch (e) {
            console.error('❌ Template PDF introuvable:', templatePath);
            return res.status(500).json({
                success: false,
                error: 'Template PDF introuvable',
                path: templatePath
            });
        }

        const pdfHtml = await ejs.renderFile(templatePath, {
            name,
            email,
            phone,
            company,
            message,
            products,
            totalPrice,
            companySiret: process.env.COMPANY_SIRET,
            companyApe: process.env.COMPANY_APE,
            companyTva: process.env.COMPANY_TVA,
            companyPhone: process.env.COMPANY_PHONE,
            companyEmail: process.env.COMPANY_EMAIL,
            companySite: process.env.COMPANY_SITE,
            tvaRate: process.env.TVA_RATE ? Number(process.env.TVA_RATE) : 0.20,
            devisNumber: process.env.DEVIS_NUMBER || undefined,
            companyName: process.env.COMPANY_NAME || 'Bedouielec Transformateurs',
            companyAddress: process.env.COMPANY_ADDRESS || ''
        });

        // Génération PDF avec Playwright
        let pdfBuffer;
        try {
            console.log('Lancement du navigateur...');
            
            // Détection de l'exécutable Chromium
            try {
                const detected = await findChromiumExecutable();
                if (detected) {
                    playwrightConfig.executablePath = detected;
                }
                console.log('Chemin exécutable Playwright (détecté):', playwrightConfig.executablePath);
            } catch (e) {
                console.warn('Impossible de détecter automatiquement l\'exécutable playwright:', e && e.message);
            }

            const browser = await chromium.launch(playwrightConfig);
            console.log('Navigateur lancé avec succès');
            
            const context = await browser.newContext();
            console.log('Contexte créé avec succès');
            
            const page = await context.newPage();
            console.log('Page créée avec succès');
            
            await page.setContent(pdfHtml);
            console.log('Contenu défini avec succès');
            
            pdfBuffer = await page.pdf({ 
                format: 'A4',
                margin: { top: '10mm', bottom: '10mm', left: '10mm', right: '10mm' },
                printBackground: true
            });
            console.log('PDF généré avec succès, taille:', pdfBuffer.length, 'octets');
            
            await context.close();
            await browser.close();
            console.log('Navigateur fermé avec succès');
            
        } catch (e) {
            console.error('Erreur génération PDF avec Playwright:', e);
            console.error('Stack trace:', e.stack);
            return res.status(500).json({ 
                success: false, 
                error: 'Erreur génération PDF',
                details: isProd ? 'Erreur serveur' : e.message
            });
        }

        // Sauvegarde du PDF
        const pdfDir = path.join(process.cwd(), process.env.PDF_STORAGE_PATH || 'generated-pdfs');
        await fs.mkdir(pdfDir, { recursive: true });
        const fileName = `devis-${Date.now()}.pdf`;
        const filePath = path.join(pdfDir, fileName);
        
        try {
            await fs.writeFile(filePath, pdfBuffer);
            console.log('PDF écrit à:', filePath);
        } catch (e) {
            console.error('Erreur écriture fichier PDF:', e);
            throw e;
        }

        // Génération du lien de téléchargement sécurisé
        const baseUrl = req.protocol + '://' + req.get('host');
        const tokenPayload = {
            name: fileName,
            exp: Math.floor(Date.now() / 1000) + DOWNLOAD_TOKEN_TTL
        };
        const token = signDownloadToken(tokenPayload);
        const downloadUrl = `${baseUrl}/download-devis/${encodeURIComponent(fileName)}?token=${encodeURIComponent(token)}`;

        // Bouton de téléchargement PDF
        const pdfButtonHtml = `
            <div style="text-align:center;margin:20px 0;">
                <a href="${downloadUrl}" style="background:#e74c3c;color:white;padding:12px 20px;text-decoration:none;border-radius:5px;font-weight:bold;display:inline-block;">📄 Télécharger le Devis (PDF)</a>
                <p style="font-size:12px;color:#666;margin-top:8px;">Le devis est également disponible en pièce jointe.</p>
            </div>
        `;

        const mailHtml = emailTemplate.replace('<!-- PDF_BUTTON_PLACEHOLDER -->', pdfButtonHtml);

        // Configuration email de base
        const mailBase = {
            from: `"Système de Devis" <${SMTP_USER}>`,
            subject: `🔔 Nouvelle demande de devis - ${name} (${totalPrice.toLocaleString()} TND)`,
            html: mailHtml,
            attachments: [
                {
                    filename: fileName,
                    content: pdfBuffer,
                    contentType: 'application/pdf',
                    contentDisposition: 'attachment',
                    cid: 'devis.pdf'
                }
            ]
        };

        // Envoi des emails aux admins
        try {
            let recSet = sentRecipients.get(bodySig);
            if (!recSet) {
                recSet = new Set();
                sentRecipients.set(bodySig, recSet);
            }
            
            const toSendAdmins = adminEmails.filter(r => !recSet.has(r));
            if (toSendAdmins.length > 0) {
                console.log('Envoi emails admin individuellement à:', toSendAdmins.join(', '));
                
                for (const adminAddr of toSendAdmins) {
                    const singleMail = { ...mailBase, to: adminAddr };
                    
                    // Nettoyage défensif des champs inattendus
                    if (singleMail.bcc) delete singleMail.bcc;
                    if (singleMail.cc) delete singleMail.cc;
                    
                    // Enveloppe SMTP explicite
                    const envelope = { from: SMTP_USER, to: adminAddr };
                    singleMail.envelope = envelope;
                    
                    console.log('ENVELOPPE SMTP ADMIN ->', envelope);
                    
                    const info = await transporter.sendMail(singleMail);
                    console.log(`✅ Email envoyé avec succès à l'admin ${adminAddr}. MessageId: ${info.messageId}`);
                    
                    recSet.add(adminAddr);
                }
            } else {
                console.log('Tous les destinataires admin déjà envoyés pour cette signature');
            }
            
            sentRecords.set(bodySig, Math.floor(Date.now() / 1000));
            
        } catch (e) {
            console.error('Erreur envoi email admin:', e);
            return res.status(500).json({
                success: false,
                error: 'Erreur envoi email',
                details: isProd ? 'Erreur serveur' : e.message
            });
        }

        // Envoi email au client
        try {
            const clientEmail = email;
            if (clientEmail && !adminEmails.includes(clientEmail)) {
                const clientMail = {
                    from: `"Système de Devis" <${SMTP_USER}>`,
                    to: clientEmail,
                    subject: `Votre devis - ${name} (${totalPrice.toLocaleString()} TND)`,
                    html: mailHtml,
                    attachments: [
                        {
                            filename: fileName,
                            content: pdfBuffer,
                            contentType: 'application/pdf',
                            contentDisposition: 'attachment',
                            cid: 'devis.pdf'
                        }
                    ]
                };

                let recSet = sentRecipients.get(bodySig);
                if (!recSet) {
                    recSet = new Set();
                    sentRecipients.set(bodySig, recSet);
                }
                
                if (!recSet.has(clientEmail)) {
                    // Nettoyage défensif
                    if (clientMail.bcc) delete clientMail.bcc;
                    if (clientMail.cc) delete clientMail.cc;
                    
                    const envelope = { from: SMTP_USER, to: clientEmail };
                    clientMail.envelope = envelope;
                    
                    console.log('ENVELOPPE SMTP CLIENT ->', envelope);
                    
                    const infoClient = await transporter.sendMail(clientMail);
                    console.log(`✅ Email envoyé avec succès au client ${clientEmail}. MessageId: ${infoClient.messageId}`);
                    
                    recSet.add(clientEmail);
                }
            } else if (clientEmail === RECEIVER_EMAIL) {
                console.log('Email client égal email admin; le client ne recevra pas d\'email séparé pour éviter les doublons.');
            } else {
                console.log('Pas d\'email client fourni; saut de l\'envoi client.');
            }
            
        } catch (e) {
            console.error('Erreur envoi email client:', e);
            // Ne pas faire échouer la requête si l'email admin a réussi
        }

        console.log('✅ Processus de devis terminé avec succès');
        return res.status(200).json({ success: true });

    } catch (err) {
        console.error('❌ Erreur dans /send-quote:', err);
        
        if (err.code === 'EAUTH') {
            console.error('🔑 Échec de l\'authentification. Veuillez vérifier les identifiants Gmail SMTP dans le fichier .env.');
            return res.status(500).json({
                success: false,
                error: 'Erreur d\'authentification email',
                message: 'Configuration SMTP invalide'
            });
        }
        
        return res.status(500).json({ 
            success: false, 
            error: isProd ? 'Erreur serveur' : err.message,
            message: 'Une erreur est survenue lors du traitement de votre demande'
        });
    }
});

// Route de téléchargement PDF sécurisée
app.get('/download-devis/:name', async (req, res) => {
    try {
        const name = req.params.name;
        const token = req.query.token;
        
        if (!token || typeof token !== 'string') {
            return res.status(401).send('Non autorisé: token manquant');
        }
        
        const payload = verifyDownloadToken(token);
        if (!payload || payload.name !== name) {
            return res.status(403).send('Interdit: token invalide ou expiré');
        }
        
        const filePath = path.join(process.cwd(), 'generated-pdfs', name);
        
        // Vérifier que le fichier existe
        try {
            await fs.access(filePath);
        } catch (e) {
            console.error('PDF demandé introuvable:', filePath, e);
            return res.status(404).send('Non trouvé');
        }
        
        return res.download(filePath);
        
    } catch (e) {
        console.error('Erreur service PDF', e);
        return res.status(500).send('Erreur interne');
    }
});

// Route admin pour test (protégée par SERVICE_ROLE_KEY)
app.get('/admin/cart/:userId', async (req, res) => {
    try {
        const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
        if (!serviceKey) return res.status(403).json({ error: 'Clé de rôle de service non configurée' });
        
        const userId = req.params.userId;
        const fetch = (await import('node-fetch')).default;
        const supabaseUrl = process.env.VITE_SUPABASE_URL;
        
        const resp = await fetch(`${supabaseUrl}/rest/v1/carts?user_id=eq.${userId}`, {
            headers: {
                apikey: serviceKey,
                Authorization: `Bearer ${serviceKey}`
            }
        });
        
        const data = await resp.json();
        return res.json({ data });
        
    } catch (e) {
        console.error('Erreur dans /admin/cart/:userId', e);
        return res.status(500).json({ error: e.message });
    }
});

// Health check optimisé avec cache
let cachedHealthCheck = null;
let lastHealthCheck = 0;
const HEALTH_CHECK_TTL = 60000; // Cache pendant 1 minute

app.get('/health', async (req, res) => {
    const now = Date.now();
    
    // Retourner le résultat en cache si disponible et frais
    if (cachedHealthCheck && (now - lastHealthCheck < HEALTH_CHECK_TTL)) {
        return res.json(cachedHealthCheck);
    }

    try {
        const execAsync = promisify(exec);
        let chromeVersion = null;
        
        try {
            const { stdout } = await execAsync('chromium --version');
            chromeVersion = stdout.trim();
        } catch (e) {
            try {
                const { stdout } = await execAsync('/usr/bin/chromium --version');
                chromeVersion = stdout.trim();
            } catch (e2) {
                chromeVersion = null;
            }
        }

        // Vérifier si le répertoire PDF existe et est accessible en écriture
        let pdfDirStatus = 'ok';
        try {
            await fs.access('./generated-pdfs', fs.constants.W_OK);
        } catch (e) {
            pdfDirStatus = 'erreur';
        }

        // Vérifier la configuration SMTP
        const smtpStatus = {
            configured: !!(process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS),
            host: process.env.SMTP_HOST || 'non configuré',
            user: process.env.SMTP_USER ? 'configuré' : 'non configuré'
        };

        const healthStatus = {
            status: 'healthy',
            timestamp: new Date().toISOString(),
            chrome: chromeVersion,
            node: process.version,
            environment: process.env.NODE_ENV,
            memory: {
                heapUsed: Math.round(process.memoryUsage().heapUsed / 1024 / 1024),
                heapTotal: Math.round(process.memoryUsage().heapTotal / 1024 / 1024),
                rss: Math.round(process.memoryUsage().rss / 1024 / 1024)
            },
            uptime: Math.round(process.uptime()),
            pdfDirectory: pdfDirStatus,
            smtp: smtpStatus
        };

        // Mettre en cache le résultat
        cachedHealthCheck = healthStatus;
        lastHealthCheck = now;

        return res.json(healthStatus);
        
    } catch (error) {
        const fallbackStatus = {
            status: 'healthy',
            timestamp: new Date().toISOString(),
            chrome: null,
            node: process.version,
            environment: process.env.NODE_ENV,
            note: 'vérification de santé partiellement échouée',
            error: isProd ? 'erreur interne' : error.message
        };

        // Mettre en cache le résultat de repli
        cachedHealthCheck = fallbackStatus;
        lastHealthCheck = now;

        return res.json(fallbackStatus);
    }
});

// Endpoint de debug Playwright (à supprimer en production)
app.get('/debug/playwright', async (req, res) => {
    if (isProd) {
        return res.status(404).json({ error: 'Non trouvé' });
    }
    
    try {
        console.log('Point de terminaison DEBUG /debug/playwright invoqué');
        
        const candidates = [
            process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
            process.env.CHROME_BIN,
            '/usr/bin/chromium',
            '/usr/bin/chromium-browser',
            '/usr/bin/google-chrome',
            '/usr/bin/google-chrome-stable'
        ].filter(Boolean);
        
        const checks = {};
        for (const c of candidates) {
            try {
                await fs.access(c);
                checks[c] = true;
            } catch (e) {
                checks[c] = false;
            }
        }
        
        let pwPath = null;
        try {
            pwPath = await chromium.executablePath();
        } catch (e) {
            pwPath = null;
        }
        
        return res.json({
            environment: {
                PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || null,
                CHROME_BIN: process.env.CHROME_BIN || null
            },
            candidates,
            checks,
            playwrightReportedExecutablePath: pwPath
        });
        
    } catch (e) {
        return res.status(500).json({ error: e.message });
    }
});

const PORT = process.env.PORT || 5000;

app.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 Serveur en cours d'exécution sur le port ${PORT}`);
    console.log(`📡 Serveur accessible à:`);
    console.log(`   - http://localhost:${PORT}`);
    console.log(`   - http://0.0.0.0:${PORT}`);
    console.log(`📧 Configuration SMTP:`, {
        host: process.env.SMTP_HOST || 'NON_CONFIGURÉ',
        user: process.env.SMTP_USER ? 'CONFIGURÉ' : 'NON_CONFIGURÉ',
        pass: process.env.SMTP_PASS ? 'CONFIGURÉ' : 'NON_CONFIGURÉ'
    });
    console.log(`🔑 Configuration API:`, {
        apiKey: apiKey ? 'CONFIGURÉ' : 'NON_CONFIGURÉ',
        frontendOrigin: process.env.FRONTEND_ORIGIN || 'NON_CONFIGURÉ'
    });
});
