"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.queryAll = queryAll;
async function queryAll(conn, cypher) {
    const result = await conn.query(cypher);
    const qr = Array.isArray(result) ? result[0] : result;
    return qr.getAll();
}
