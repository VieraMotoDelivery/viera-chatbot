const { Client, Location, Poll, List, Buttons, LocalAuth } = require('./index');
const repl = require('repl');
const express = require("express");
const { body, validationResult } = require("express-validator");
const socketIO = require("socket.io");
const qrcode = require("qrcode");
const http = require("http");
const fs = require("fs");
const { phoneNumberFormatter } = require("./helpers/formatter");
const fileUpload = require("express-fileupload");
const axios = require("axios");
const { Requests } = require("./src/request.js");
const path = require('path');

const {
    checkingNumbers,
    codigoetelefone,
    listarentregasequantidade,
    listartodosclientescadastrados,
    buscardadosdecadastradodaempresa,
    deletarentregas,
    deletarcliente,
    ativarchatbot,
    desativarchatbot,
    cronJob,
    listarQuantidadeDeEntregasDaEmpresa,
    excluirnumerocliente,
} = require("./src/middlewares.js");
const { sosregistrarcodigo } = require("./src/sosregistrarcodigo.js");
const { clientecadastro } = require("./src/clientecadastro.js");
const { empresa } = require("./src/empresa.js");
const { fisica } = require("./src/fisica.js");

const client = new Client({
    // restartOnAuthFail: true,
    authStrategy: new LocalAuth(),
    webVersionCache: {
        type: 'remote',
        remotePath: 'https://raw.githubusercontent.com/wppconnect-team/wa-version/main/html/2.3000.0.html',
    },
    puppeteer: {
        headless: true,
        args: ['--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-accelerated-2d-canvas',
            '--no-first-run',
            '--no-zygote',
            '--single-process', // <- this one doesn't works in Windows
            '--disable-gpu'
        ],
    },
});

const port = process.env.PORT || 7005;

const app = express();
const server = http.createServer(app);
const io = socketIO(server);


app.use(express.json());
app.use(
    express.urlencoded({
        extended: true,
    })
);

app.use(
    fileUpload({
        debug: true,
    })
);

app.get("/", (req, res) => {
    res.sendFile("index.html", {
        root: __dirname,
    });
});

server.listen(port, function () {
    console.log("App running on *: " + port);
});

// client initialize does not finish at ready now.
client.initialize();

client.on('loading_screen', (percent, message) => {
    console.log('LOADING SCREEN', percent, message);
});

// Pairing code only needs to be requested once
let pairingCodeRequested = false;
client.on('qr', async (qr) => {
    // NOTE: This event will not be fired if a session is specified.
    console.log('QR RECEIVED', qr);

    // paiuting code example
    const pairingCodeEnabled = false;
    if (pairingCodeEnabled && !pairingCodeRequested) {
        const pairingCode = await client.requestPairingCode('96170100100'); // enter the target phone number
        console.log('Pairing code enabled, code: ' + pairingCode);
        pairingCodeRequested = true;
    }
});

client.on('authenticated', () => {
    console.log('AUTHENTICATED');
});

client.on('auth_failure', msg => {
    // Fired if session restore was unsuccessful
    console.error('AUTHENTICATION FAILURE', msg);
});

client.on('ready', async () => {
    console.log('READY');
    const debugWWebVersion = await client.getWWebVersion();
    console.log(`WWebVersion = ${debugWWebVersion}`);

    client.pupPage.on('pageerror', function (err) {
        console.log('Page error: ' + err.toString());
    });
    client.pupPage.on('error', function (err) {
        console.log('Page error: ' + err.toString());
    });

});

cronJob();
const messageTracker = new Map();
const BLOCK_THRESHOLD = 5;
const TIME_WINDOW = 300000; // 5 minutos

function shouldBlockMessage(phoneNumber, messageContent) {
    const key = `${phoneNumber}:${messageContent.toLowerCase().trim()}`;
    const now = Date.now();

    if (!messageTracker.has(key)) {
        messageTracker.set(key, { count: 1, firstSeen: now });
        return false;
    }

    const data = messageTracker.get(key);

    if (now - data.firstSeen > TIME_WINDOW) {
        messageTracker.set(key, { count: 1, firstSeen: now });
        return false;
    }

    data.count++;

    if (data.count >= BLOCK_THRESHOLD) {
        console.log(`BLOCKED: ${phoneNumber} - Mensagem repetida ${data.count} vezes: "${messageContent}"`);
        return true;
    }

    return false;
}

function cleanupOldEntries() {
    const now = Date.now();
    for (const [key, data] of messageTracker.entries()) {
        if (now - data.firstSeen > TIME_WINDOW) {
            messageTracker.delete(key);
        }
    }
}

// Limpar entradas antigas a cada 10 minutos
setInterval(cleanupOldEntries, 600000);

client.on("message", async (msg) => {
    // ANTI-LOOP: Verificar se deve bloquear esta mensagem
    if (shouldBlockMessage(msg.from, msg.body)) {
        console.log(`Mensagem bloqueada de ${msg.from}: "${msg.body}"`);
        return; // Para o processamento aqui
    }

    let msgNumber = await checkingNumbers(msg);
    let etapaRetrieve = await Requests.retrieveEtapa(msg);
    let codigotelefone = codigoetelefone(msg.from, msgNumber);
    let buscarseexistetelefonenobanco = await Requests.buscartelefonenobanco(
        msg.from
    );

    // Resto do código continua normalmente...
    const date = new Date();
    const h = date.getHours();

    if (etapaRetrieve !== undefined && etapaRetrieve.ativado == true) {
        sosregistrarcodigo(msg, etapaRetrieve, client);
        clientecadastro(msgNumber, msg, etapaRetrieve, client);
        const message = msg.body.toLowerCase();
        let desativar = message.slice(0, 9);
        let ativar = message.slice(0, 6);
        let listDelivery = message.includes("entregas/");

        if (
            buscarseexistetelefonenobanco &&
            !listDelivery &&
            ativar != "ativar" &&
            desativar != "desativar"
        ) {
            if (h >= 10 && h < 23) {
                empresa(msg, msgNumber, etapaRetrieve, codigotelefone, client);
            } else if (h < 10) {
                client.sendMessage(
                    msg.from,
                    `Olá! 😃
Gostaríamos de informar que nosso horário de *atendimento* inicia as 🕥 10h00 até às 23h00 🕙 e as atividades das 🕥 10h30 até às 23h00 🕙.

Alguma dúvida ou assistência, recomendamos que entre em contato novamente mais tarde. 🏍️

Obrigado pela compreensão!`
                );
            } else if (h > 10 && h >= 23) {
                client.sendMessage(
                    msg.from,
                    `Pedimos desculpas pelo inconveniente, pois nosso horário de *atendimento* é das 🕥 10h30 até às 23h00 🕙.
                    
Se você tiver alguma dúvida ou precisar de assistência nos mande uma mensagem no grupo de whatsApp.
    
Agradecemos pela compreensão.`
                );
            }
        } else if (!buscarseexistetelefonenobanco && !listDelivery) {
            if (h >= 10 && h < 23) {
                let registrarCode = msg.body.includes("/registrar/.");
                let registrar = msg.body.includes("/registrar");
                if (!registrarCode && !registrar) {
                    fisica(
                        msg,
                        etapaRetrieve,
                        client,
                        buscarseexistetelefonenobanco
                    );
                }
            } else if (h < 10) {
                client.sendMessage(
                    msg.from,
                    `Olá! 😃
Gostaríamos de informar que nosso horário de *atendimento* inicia as 🕥 10h00 até às 23h00 🕙 e as atividades das 🕥 10h30 até às 23h00 🕙.
        
Alguma dúvida ou assistência, recomendamos que entre em contato novamente mais tarde. 🏍️
    
Obrigado pela compreensão!`
                );
            } else if (h > 10 && h >= 23) {
                client.sendMessage(
                    msg.from,
                    `Olá! 😃
Pedimos desculpas pelo inconveniente, pois nosso horário de *atendimento* é das 🕥 10h30 até às 23h00 🕙.
    
Se você tiver alguma dúvida ou precisar de assistência recomendamos que entre em contato conosco novamente amanhã a partir das 🕙 10h00, quando retomaremos nossas atividades. 🏍️
    
Agradecemos pela compreensão.`
                );
            }
        }
    }

    listarentregasequantidade(msg, client);
    listartodosclientescadastrados(msg, client);
    buscardadosdecadastradodaempresa(msg, client, msgNumber);
    deletarentregas(msg, client);
    deletarcliente(msg, client);
    ativarchatbot(msg, client);
    desativarchatbot(msg, client);
    listarQuantidadeDeEntregasDaEmpresa(codigotelefone, msg, client);
    excluirnumerocliente(msg, client);
});

const checkRegisteredNumber = async function (number) {
    const isRegistered = await client.isRegisteredUser(number);
    return isRegistered;
};

// Send message
app.post(
    "/send-message",
    [body("number").notEmpty(), body("message").notEmpty()],
    async (req, res) => {
        const errors = validationResult(req).formatWith(({ msg }) => {
            return msg;
        });

        if (!errors.isEmpty()) {
            return res.status(422).json({
                status: false,
                message: errors.mapped(),
            });
        }

        const number = phoneNumberFormatter(req.body.number);
        const message = req.body.message;

        const isRegisteredNumber = await checkRegisteredNumber(number);

        if (!isRegisteredNumber) {
            return res.status(422).json({
                status: false,
                message: "The number is not registered",
            });
        }

        client
            .sendMessage(number, message)
            .then((response) => {
                res.status(200).json({
                    status: true,
                    response: response,
                });
            })
            .catch((err) => {
                res.status(500).json({
                    status: false,
                    response: err,
                });
            });
    }
);

const findGroupByName = async function (name) {
    const group = await client.getChats().then((chats) => {
        return chats.find(
            (chat) => chat.isGroup && chat.name.toLowerCase() == name.toLowerCase()
        );
    });
    return group;
};
// Send message to group
// You can use chatID or group name, year
app.post(
    "/send-group-message",
    [
        body("id").custom((value, { req }) => {
            if (!value && !req.body.name) {
                throw new Error("Invalid value, you can use `id` or `name`");
            }
            return true;
        }),
        body("message").notEmpty(),
    ],
    async (req, res) => {
        const errors = validationResult(req).formatWith(({ msg }) => {
            return msg;
        });

        if (!errors.isEmpty()) {
            return res.status(422).json({
                status: false,
                message: errors.mapped(),
            });
        }

        let chatId = req.body.id;
        const groupName = req.body.name;
        const message = req.body.message;

        // Find the group by name
        if (!chatId) {
            const group = await findGroupByName(groupName);
            if (!group) {
                return res.status(422).json({
                    status: false,
                    message: "No group found with name: " + groupName,
                });
            }
            chatId = group.id._serialized;
        }

        client
            .sendMessage(chatId, message)
            .then((response) => {
                res.status(200).json({
                    status: true,
                    response: response,
                });
            })
            .catch((err) => {
                res.status(500).json({
                    status: false,
                    response: err,
                });
            });
    }
);

// Socket IO
io.on("connection", function (socket) {
    socket.emit("message", "Connecting...");

    client.on("qr", (qr) => {
        console.log("QR RECEIVED", qr);
        qrcode.toDataURL(qr, (err, url) => {
            socket.emit("qr", url);
            socket.emit("message", "QR Code received, scan please!");
        });
    });

    client.on("ready", () => {
        socket.emit("ready", "Whatsapp is ready!");
        socket.emit("message", "Whatsapp is ready!");
    });


    client.on("authenticated", () => {
        socket.emit("authenticated", "Whatsapp is authenticated!");
        socket.emit("message", "Whatsapp is authenticated!");
        console.log("AUTHENTICATED");
    });

    client.on("auth_failure", function (session) {
        socket.emit("message", "Auth failure, restarting...");
    });

    client.on("disconnected", (reason) => {
        socket.emit("message", "Whatsapp is disconnected!");
        client.destroy();
        client.initialize();
    });
});

client.on('message_create', async (msg) => {
    // Fired on all message creations, including your own
    if (msg.fromMe) {
        // do stuff here
    }

    // Unpins a message
    if (msg.fromMe && msg.body.startsWith('!unpin')) {
        const pinnedMsg = await msg.getQuotedMessage();
        if (pinnedMsg) {
            // Will unpin a message
            const result = await pinnedMsg.unpin();
            console.log(result); // True if the operation completed successfully, false otherwise
        }
    }
});

client.on('message_ciphertext', (msg) => {
    // Receiving new incoming messages that have been encrypted
    // msg.type === 'ciphertext'
    msg.body = 'Waiting for this message. Check your phone.';

    // do stuff here
});

client.on('message_revoke_everyone', async (after, before) => {
    // Fired whenever a message is deleted by anyone (including you)
    console.log(after); // message after it was deleted.
    if (before) {
        console.log(before); // message before it was deleted.
    }
});

client.on('message_revoke_me', async (msg) => {
    // Fired whenever a message is only deleted in your own view.
    console.log(msg.body); // message before it was deleted.
});

client.on('message_ack', (msg, ack) => {
    /*
        == ACK VALUES ==
        ACK_ERROR: -1
        ACK_PENDING: 0
        ACK_SERVER: 1
        ACK_DEVICE: 2
        ACK_READ: 3
        ACK_PLAYED: 4
    */

    if (ack == 3) {
        // The message was read
    }
});

client.on('group_join', (notification) => {
    // User has joined or been added to the group.
    console.log('join', notification);
    notification.reply('User joined.');
});

client.on('group_leave', (notification) => {
    // User has left or been kicked from the group.
    console.log('leave', notification);
    notification.reply('User left.');
});

client.on('group_update', (notification) => {
    // Group picture, subject or description has been updated.

});

client.on('change_state', state => {
    console.log('CHANGE STATE', state);
});

// Change to false if you don't want to reject incoming calls
let rejectCalls = true;

// client.on('call', async (call) => {
//     console.log('Call received, rejecting. GOTO Line 261 to disable', call);
//     if (rejectCalls) await call.reject();
//     await client.sendMessage(call.from, `[${call.fromMe ? 'Outgoing' : 'Incoming'}] Phone call from ${call.from}, type ${call.isGroup ? 'group' : ''} ${call.isVideo ? 'video' : 'audio'} call. ${rejectCalls ? 'This call was automatically rejected by the script.' : ''}`);
// });

client.on('disconnected', (reason) => {
    console.log('Client was logged out', reason);
});

client.on('contact_changed', async (message, oldId, newId, isContact) => {
    /** The time the event occurred. */
    const eventTime = (new Date(message.timestamp * 1000)).toLocaleString();

    /**
     * Information about the @param {message}:
     * 
     * 1. If a notification was emitted due to a group participant changing their phone number:
     * @param {message.author} is a participant's id before the change.
     * @param {message.recipients[0]} is a participant's id after the change (a new one).
     * 
     * 1.1 If the contact who changed their number WAS in the current user's contact list at the time of the change:
     * @param {message.to} is a group chat id the event was emitted in.
     * @param {message.from} is a current user's id that got an notification message in the group.
     * Also the @param {message.fromMe} is TRUE.
     * 
     * 1.2 Otherwise:
     * @param {message.from} is a group chat id the event was emitted in.
     * @param {message.to} is @type {undefined}.
     * Also @param {message.fromMe} is FALSE.
     * 
     * 2. If a notification was emitted due to a contact changing their phone number:
     * @param {message.templateParams} is an array of two user's ids:
     * the old (before the change) and a new one, stored in alphabetical order.
     * @param {message.from} is a current user's id that has a chat with a user,
     * whos phone number was changed.
     * @param {message.to} is a user's id (after the change), the current user has a chat with.
     */
});

client.on('group_admin_changed', (notification) => {
    if (notification.type === 'promote') {
        /** 
          * Emitted when a current user is promoted to an admin.
          * {@link notification.author} is a user who performs the action of promoting/demoting the current user.
          */
        console.log(`You were promoted by ${notification.author}`);
    } else if (notification.type === 'demote')
        /** Emitted when a current user is demoted to a regular user. */
        console.log(`You were demoted by ${notification.author}`);
});

client.on('group_membership_request', async (notification) => {
    /**
     * The example of the {@link notification} output:
     * {
     *     id: {
     *         fromMe: false,
     *         remote: 'groupId@g.us',
     *         id: '123123123132132132',
     *         participant: 'number@c.us',
     *         _serialized: 'false_groupId@g.us_123123123132132132_number@c.us'
     *     },
     *     body: '',
     *     type: 'created_membership_requests',
     *     timestamp: 1694456538,
     *     chatId: 'groupId@g.us',
     *     author: 'number@c.us',
     *     recipientIds: []
     * }
     *
     */
    console.log(notification);
    /** You can approve or reject the newly appeared membership request: */
    await client.approveGroupMembershipRequestss(notification.chatId, notification.author);
    await client.rejectGroupMembershipRequests(notification.chatId, notification.author);
});

client.on('message_reaction', async (reaction) => {

});