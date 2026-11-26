'use strict';

const net = require('node:net');
const socket = net.createConnection({ host: '127.0.0.1', port: 1025 });
const timer = setTimeout(() => socket.destroy(new Error('SMTP health check timed out')), 2000);
socket.once('connect', () => { clearTimeout(timer); socket.end(); });
socket.once('close', hadError => process.exit(hadError ? 1 : 0));
socket.once('error', () => process.exit(1));
