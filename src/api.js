const axios = require("axios");

const api = axios.create({
    // baseURL: "http://localhost:3000",
    baseURL: "https://database-sos.up.railway.app",
    // baseURL: "https://web-production-037c.up.railway.app",
    // baseURL: "https://database-sos.cyclic.app"
    timeout: 15000,
});

module.exports = { api };