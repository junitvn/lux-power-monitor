#!/usr/bin/env node
"use strict";

const net = require("net");
const WebSocket = require("ws");

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

// Connect to inverter
const client = net.createConnection({ host: INVERTER_IP, port: PORT }, () => {
  console.log(`Connected to inverter at ${INVERTER_IP}:${PORT}`);
  // initial read and start periodic polling
  sendReadInput();
  setInterval(sendReadInput, READ_INTERVAL);
});

client.on("data", (chunk) => {
  parserBuffer = Buffer.concat([parserBuffer, chunk]);
  parseFrames();
});

client.on("close", () => {
  console.log("Connection closed");
  process.exit(0);
});

client.on("error", (err) => {
  console.error("Connection error:", err);
  process.exit(1);
});

// Parse incoming frames
function parseFrames() {
  while (true) {
    if (parserBuffer.length < 2) break;
    // sync prefix
    if (parserBuffer[0] !== 0xa1 || parserBuffer[1] !== 0x1a) {
      const idx = parserBuffer.indexOf(0xa1, 1);
      if (idx < 0) {
        parserBuffer = Buffer.alloc(0);
        break;
      }
      parserBuffer = parserBuffer.slice(idx);
      continue;
    }
    if (parserBuffer.length < 6) break;
    const len = parserBuffer[5] * 256 + parserBuffer[4];
    const fullLen = len + 6;
    if (parserBuffer.length < fullLen) break;
    const frame = parserBuffer.slice(0, fullLen);
    parserBuffer = parserBuffer.slice(fullLen);
    handleFrame(frame);
  }
}

// Handle a complete TCP frame
function handleFrame(frame) {
  // Debug: print raw frame data as hex
  console.log(
    "Raw frame:",
    frame
      .toString("hex")
      .match(/.{1,2}/g)
      .join(" ")
  );
  const fn = frame[7];
  if (fn === 194) {
    // TRANSLATE - read input response
    // Read registers as Java LocalOverviewFragment
    const r7 = getRegister2(frame, 7);
    const r8 = getRegister2(frame, 8);
    const r9 = getRegister2(frame, 9);
    const outInv = getRegister2(frame, 16);
    const inInv = getRegister2(frame, 17);
    const outGrid = getRegister2(frame, 26);
    const inGrid = getRegister2(frame, 27);

    // PV flow calculation: sum of three PV registers for non-AC charger
    const totalPv = r7 + r8 + r9;
    // Consumption: (outInv - inInv) + (inGrid - outGrid), floor at 0
    let consumption = outInv - inInv + (inGrid - outGrid);
    if (consumption < 0) consumption = 0;

    console.log("PV Flow:", totalPv + " W");
    console.log("Consumption:", consumption + " W");
    // Lấy và hiển thị tất cả các giá trị register có thể lấy từ frame
    const allRegisters = [];
    for (let i = 0; ; i++) {
      const p = i * 2 + 35;
      if (p + 1 >= frame.length) break;
      allRegisters.push(getRegister2(frame, i));
    }

    const value4 = allRegisters[4] / 10; // Điện áp
    const value5 = allRegisters[5]; // % pin

    const value7 = allRegisters[7]; // PV1
    const value8 = allRegisters[8]; // Pv2
    const v10 = allRegisters[10]; // điện áp sạc vào pin hoặc xả ra
    const v9 = allRegisters[9]; //

    console.log("Điện áp: ", value4);
    console.log("% pin: ", value5);
    console.log("PV1: ", value7);
    console.log("PV2: ", value8);
    console.log("Điện áp sạc/xả: ", v10);
    console.log("value 9 ", v9);
    console.log("Lấy lưới: ", allRegisters[27]);

    console.log("Tất cả giá trị register:");
    allRegisters.forEach((val, idx) => {
      console.log(`Register[${idx}]: ${val}`);
    });

    const data = {
      voltage: value4,
      percent: value5,
      pv1: value7,
      pv2: value8,
      chargeVoltage: v10,
      value9: v9,
      allRegisters,
      pvFlow: totalPv,
      consumption,
      useGrid: allRegisters[27],
      totalGrid: allRegisters[37] / 10,
      totalChargeToday: allRegisters[33] / 10,
      totalDischargeToday: allRegisters[34] / 10,
      backupPower: allRegisters[24],
    };
    broadcast(data);
  }
}

// Mirror of FrameTool.getRegister2
function getRegister2(buf, index) {
  const p = index * 2 + 35;
  if (p + 1 >= buf.length) return 0;
  const low = buf[p];
  const high = buf[p + 1];
  return (high << 8) + low;
}

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
