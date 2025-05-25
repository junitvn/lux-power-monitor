#!/usr/bin/env node
"use strict";

const net = require("net");
const WebSocket = require("ws");
const express = require('express');
const path = require('path');

const INVERTER_IP = "192.168.1.12";
const PORT = 8000;

// Change protocol selection to CLI arg or default
const defaultProtocol = parseInt(process.argv[2] || "1", 10);
if (![1, 2].includes(defaultProtocol)) {
  console.error("Invalid protocol. Use 1 or 2.");
  process.exit(1);
}
console.log("Using TCP protocol:", defaultProtocol);

// Add default protocol and default datalog SN
const DEFAULT_DATALOG_SN = Buffer.alloc(10, 0xff);
// Empty inverter SN (10 null bytes) for commands
const EMPTY_INVERTER_SN = Buffer.alloc(10, 0x00);
// Interval between reads (ms)
const READ_INTERVAL = 5000;

// Modbus CRC16 calculation
function crc16Modbus(buffer, length) {
  let crc = 0xffff;
  for (let pos = 0; pos < length; pos++) {
    crc ^= buffer[pos] & 0xff;
    for (let i = 0; i < 8; i++) {
      if ((crc & 0x0001) !== 0) {
        crc = (crc >> 1) ^ 0xa001;
      } else {
        crc = crc >> 1;
      }
    }
  }
  return crc & 0xffff;
}

// Build Read Input Command (modbus) buffer
function buildReadInputCommandBuffer(serialBuffer, startAddress, pointNumber) {
  const cmd = Buffer.alloc(18);
  cmd.writeUInt8(0, 0); // address
  cmd.writeUInt8(4, 1); // function code R_INPUT (4)
  serialBuffer.copy(cmd, 2, 0, 10); // datalogSn
  // start address
  cmd.writeUInt8(startAddress & 0xff, 12);
  cmd.writeUInt8((startAddress >> 8) & 0xff, 13);
  // point number
  cmd.writeUInt8(pointNumber & 0xff, 14);
  cmd.writeUInt8((pointNumber >> 8) & 0xff, 15);
  // CRC16
  const crc = crc16Modbus(cmd, 16);
  cmd.writeUInt8(crc & 0xff, 16); // CRC low
  cmd.writeUInt8((crc >> 8) & 0xff, 17); // CRC high
  return cmd;
}

// Build Transfer Data buffer (datalogSn + length + command)
function buildTransferDataBuffer(datalogSnBuf, commandBuf) {
  const payloadLen = commandBuf.length;
  const buf = Buffer.alloc(10 + 2 + payloadLen);
  // datalogSn
  datalogSnBuf.copy(buf, 0, 0, 10);
  // length
  buf.writeUInt8(payloadLen & 0xff, 10);
  buf.writeUInt8((payloadLen >> 8) & 0xff, 11);
  // command
  commandBuf.copy(buf, 12);
  return buf;
}

// Build TCP Frame (AbstractTcpDataFrame)
function buildTcpFrame(protocol, functionCode, dataBuf) {
  const payloadLen = dataBuf.length + 2;
  const frame = Buffer.alloc(8 + dataBuf.length);
  frame.writeUInt8(0xa1, 0); // prefix0
  frame.writeUInt8(0x1a, 1); // prefix1
  // protocol
  frame.writeUInt8(protocol & 0xff, 2);
  frame.writeUInt8((protocol >> 8) & 0xff, 3);
  // length
  frame.writeUInt8(payloadLen & 0xff, 4);
  frame.writeUInt8((payloadLen >> 8) & 0xff, 5);
  frame.writeUInt8(1, 6);
  frame.writeUInt8(functionCode & 0xff, 7);
  dataBuf.copy(frame, 8);
  return frame;
}

// Parser state
let parserBuffer = Buffer.alloc(0);
const datalogSnBuf = DEFAULT_DATALOG_SN;

// Function to send a read input registers request
function sendReadInput() {
  const cmdBuf = buildReadInputCommandBuffer(EMPTY_INVERTER_SN, 0, 40);
  const tdBuf = buildTransferDataBuffer(datalogSnBuf, cmdBuf);
  const tcpBuf = buildTcpFrame(defaultProtocol, 194, tdBuf);
  client.write(tcpBuf);
  console.log("Sent read input registers request");
}

// Comment out TCP connection and related logic, and mock data for frontend
// const client = net.createConnection({ host: INVERTER_IP, port: PORT }, () => {
//   console.log(`Connected to inverter at ${INVERTER_IP}:${PORT}`);
//   // initial read and start periodic polling
//   sendReadInput();
//   setInterval(sendReadInput, READ_INTERVAL);
// });

// client.on("data", (chunk) => {
//   parserBuffer = Buffer.concat([parserBuffer, chunk]);
//   parseFrames();
// });

// client.on("close", () => {
//   console.log("Connection closed");
//   process.exit(0);
// });

// client.on("error", (err) => {
//   console.error("Connection error:", err);
//   process.exit(1);
// });

// Instead, periodically send mock data to WebSocket clients
function randomInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function generateMockData() {
  const allRegisters = Array.from({ length: 40 }, (_, i) => randomInt(0, 5000));
  return {
    voltage: randomInt(220, 240),
    percent: randomInt(20, 100),
    pv1: randomInt(0, 2000),
    pv2: randomInt(0, 2000),
    chargeVoltage: randomInt(-2000, 2000),
    value9: randomInt(0, 1000),
    allRegisters,
    pvFlow: allRegisters[7] + allRegisters[8] + allRegisters[9],
    consumption: randomInt(0, 5000),
    useGrid: allRegisters[27],
    totalGrid: allRegisters[37] / 10,
    totalChargeToday: allRegisters[33] / 10,
    totalDischargeToday: allRegisters[34] / 10,
    backupPower: allRegisters[24],
  };
}

setInterval(() => {
  const data = generateMockData();
  broadcast(data);
}, READ_INTERVAL);

const wss = new WebSocket.Server({ port: 8080 });
let lastData = null;
function broadcast(data) {
  lastData = data;
  wss.clients.forEach(function each(client) {
    if (client.readyState === WebSocket.OPEN) {
      client.send(JSON.stringify(data));
    }
  });
}
wss.on("connection", function connection(ws) {
  if (lastData) ws.send(JSON.stringify(lastData));
});

// Thêm express để serve file tĩnh (monitor.html)
const app = express();

// Serve tất cả file tĩnh trong thư mục hiện tại
app.use(express.static(__dirname));

// Tùy chọn: chuyển hướng / về monitor.html
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'monitor.html'));
});

// Khởi động HTTP server trên PORT phù hợp với Render
const HTTP_PORT = process.env.PORT || 3000;
app.listen(HTTP_PORT, () => {
  console.log(`HTTP server running at http://localhost:${HTTP_PORT}`);
});
