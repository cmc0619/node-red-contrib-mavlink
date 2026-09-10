'use strict';

/** MAVLink FTP wire constants and packet builders. */

const { common: { MavFtpOpcode: OPCODE, MavFtpErr: NAK_ERROR } } = require('node-mavlink');

const MAX_DATA_BYTES = 239;

/**
 * Build the fixed-size FTP payload nested in FILE_TRANSFER_PROTOCOL.
 *
 * @param {object} fields
 * @param {number} fields.seq
 * @param {number} fields.session
 * @param {number} fields.opcode
 * @param {number} fields.size
 * @param {number} fields.reqOpcode
 * @param {number} fields.burstComplete
 * @param {number} fields.offset
 * @param {Buffer} fields.data
 * @returns {Buffer}
 */
function buildPayload(fields) {
  // The frame carries the byte count in one octet and the body in 239 bytes, so
  // a longer path is unrepresentable twice over: 240 declares more than is
  // copied, 256 declares zero. Recursive backup builds paths by appending, so
  // it is generated paths that reach this, not operator input (§0 rule 1).
  if (fields.data.length > MAX_DATA_BYTES) {
    throw new RangeError(
      `FTP payload carries at most ${MAX_DATA_BYTES} bytes, got ${fields.data.length}`
    );
  }
  const payload = Buffer.alloc(251);
  payload.writeUInt16LE(fields.seq, 0);
  payload[2] = fields.session;
  payload[3] = fields.opcode;
  payload[4] = fields.size;
  payload[5] = fields.reqOpcode;
  payload[6] = fields.burstComplete;
  payload.writeUInt32LE(fields.offset, 8);
  fields.data.copy(payload, 12, 0, MAX_DATA_BYTES);
  return payload;
}

/**
 * Build a FILE_TRANSFER_PROTOCOL decoded-shape message.
 *
 * @param {{sysid:number, compid:number}} target
 * @param {Buffer} payload
 * @returns {{name:string, fields:object}}
 */
function buildMessage(target, payload) {
  return {
    name: 'FILE_TRANSFER_PROTOCOL',
    fields: {
      target_network: 0,
      target_system: target.sysid,
      target_component: target.compid,
      payload,
    },
  };
}

/**
 * Build one request. Retries must retain the returned message object so its
 * sequence number and request fields stay byte-for-byte identical.
 *
 * @param {{sysid:number, compid:number}} target
 * @param {number} seq
 * @param {number} opcode
 * @param {number} session
 * @param {number} offset
 * @param {Buffer} data
 * @param {number} size
 * @returns {{name:string, fields:object}}
 */
function buildRequest(target, seq, opcode, session, offset, data, size) {
  return buildMessage(target, buildPayload({
    seq,
    session,
    opcode,
    size,
    reqOpcode: 0,
    burstComplete: 0,
    offset,
    data,
  }));
}

/**
 * Decode the nested payload from a received FTP message.
 *
 * @param {Buffer|Uint8Array|number[]} value
 * @returns {{seq:number,session:number,opcode:number,size:number,reqOpcode:number,burstComplete:number,offset:number,data:Buffer}}
 */
function decodePayload(value) {
  const payload = Buffer.from(value);
  const size = payload[4];
  return {
    seq: payload.readUInt16LE(0),
    session: payload[2],
    opcode: payload[3],
    size,
    reqOpcode: payload[5],
    burstComplete: payload[6],
    offset: payload.readUInt32LE(8),
    data: Buffer.from(payload.subarray(12, 12 + size)),
  };
}

module.exports = {
  MAX_DATA_BYTES,
  OPCODE,
  NAK_ERROR,
  buildPayload,
  buildMessage,
  buildRequest,
  decodePayload,
};
