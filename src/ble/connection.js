/**
 * BLE Connection Manager for Puffco Proxy
 */

const noble = require('@abandonware/noble');
const EventEmitter = require('events');
const {
  SERVICES,
  CHARACTERISTICS,
  buildGetAccessSeedCommand,
  buildUnlockAccessCommand,
  buildGetLimitsCommand,
  createAuthToken,
  parseResponse
} = require('./protocol');

class PuffcoConnection extends EventEmitter {
  constructor(deviceFilter = 'proxy') {
    super();
    this.setMaxListeners(50); // Prevent EventEmitter warnings
    this.peripheral = null;
    this.server = null;
    this.characteristics = {};
    this.connected = false;
    this.authenticated = false;
    this.seq = 0;
    this.pendingResponses = new Map();
    this.deviceName = 'Unknown';
    this.deviceFilter = deviceFilter.toLowerCase();
    // Protocol limits (set during auth)
    this.maxPayload = 125;
    this.maxFiles = 0;
    this.maxCmds = 0;

    // Bind noble events
    noble.on('stateChange', this._onStateChange.bind(this));
    noble.on('discover', this._onDiscover.bind(this));
  }

  /**
   * Start scanning for Puffco devices
   */
  async scan(timeout = 15000) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        noble.stopScanning();
        reject(new Error('Scan timeout - no Puffco device found'));
      }, timeout);

      this.once('discovered', (peripheral) => {
        clearTimeout(timer);
        noble.stopScanning();
        resolve(peripheral);
      });

      if (noble.state === 'poweredOn') {
        noble.startScanning([], false);
      } else {
        noble.once('stateChange', (state) => {
          if (state === 'poweredOn') {
            noble.startScanning([], false);
          }
        });
      }
    });
  }

  /**
   * Connect to a Puffco device
   */
  async connect(peripheral = null) {
    if (!peripheral) {
      peripheral = await this.scan();
    }

    this.peripheral = peripheral;
    this.deviceName = peripheral.advertisement?.localName || 'Proxy';

    return new Promise((resolve, reject) => {
      peripheral.connect(async (err) => {
        if (err) {
          reject(err);
          return;
        }

        try {
          await this._discoverServices();
          await this._subscribe();
          await this._sendInitCommand();
          await this._authenticate();
          this.connected = true;
          this.emit('connected');
          resolve();
        } catch (e) {
          reject(e);
        }
      });

      peripheral.once('disconnect', () => {
        this.connected = false;
        this.emit('disconnected');
      });
    });
  }

  /**
   * Disconnect from device
   */
  async disconnect() {
    if (this.peripheral) {
      return new Promise((resolve) => {
        this.peripheral.disconnect(() => {
          this.connected = false;
          resolve();
        });
      });
    }
  }

  /**
   * Send a command and wait for response
   */
  async sendCommand(data, timeout = 5000) {
    // Sequence is 16-bit little-endian at bytes 0-1
    const seq = data.readUInt16LE(0);

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingResponses.delete(seq);
        reject(new Error(`Command timeout (seq=${seq})`));
      }, timeout);

      this.pendingResponses.set(seq, (response) => {
        clearTimeout(timer);
        this.pendingResponses.delete(seq);
        resolve(response);
      });

      const cmdChar = this.characteristics['command'];
      if (!cmdChar) {
        clearTimeout(timer);
        reject(new Error('Command characteristic not found'));
        return;
      }

      // Write without response for speed
      cmdChar.write(Buffer.from(data), true, (err) => {
        if (err) {
          clearTimeout(timer);
          this.pendingResponses.delete(seq);
          reject(err);
        }
      });
    });
  }

  /**
   * Get device name
   */
  getDeviceName() {
    return this.deviceName;
  }

  // Private methods

  _onStateChange(state) {
    if (state === 'poweredOn') {
      this.emit('ready');
    }
  }

  _onDiscover(peripheral) {
    const name = peripheral.advertisement?.localName || '';
    if (name.toLowerCase().includes(this.deviceFilter)) {
      this.emit('discovered', peripheral);
    }
  }

  async _discoverServices() {
    return new Promise((resolve, reject) => {
      this.peripheral.discoverAllServicesAndCharacteristics((err, services, characteristics) => {
        if (err) {
          reject(err);
          return;
        }

        // Map characteristics by UUID (lowercase, no dashes for comparison)
        for (const char of characteristics) {
          const uuid = char.uuid.toLowerCase();

          // Increase max listeners to prevent warnings during rapid polling
          if (char.setMaxListeners) {
            char.setMaxListeners(50);
          }

          // Map to friendly names
          if (uuid === '60133d5c57274f2c9697d842c5292a3c' || uuid === '60133d5c-5727-4f2c-9697-d842c5292a3c') {
            this.characteristics['command'] = char;
          } else if (uuid === '8dc5ec058f7d45ad99db3fbde65dbd9c' || uuid === '8dc5ec05-8f7d-45ad-99db-3fbde65dbd9c') {
            this.characteristics['response'] = char;
          } else if (uuid === '58b0a7aad89f4bf2961d0d892d7439d8' || uuid === '58b0a7aa-d89f-4bf2-961d-0d892d7439d8') {
            this.characteristics['state'] = char;
          }

          // Also store by full UUID
          this.characteristics[uuid] = char;
        }

        resolve();
      });
    });
  }

  async _subscribe() {
    const responseChar = this.characteristics['response'];
    if (!responseChar) {
      throw new Error('Response characteristic not found');
    }

    // Subscribe to response characteristic
    await new Promise((resolve, reject) => {
      responseChar.subscribe((err) => {
        if (err) {
          reject(err);
          return;
        }

        responseChar.on('data', (data) => {
          this._onNotification(data);
        });

        resolve();
      });
    });

    // Also subscribe to notify_alt characteristic (43312cd1-7d34-46ce-a7d3-0a98fd9b4cb8)
    const notifyAltChar = this.characteristics['43312cd17d3446cea7d30a98fd9b4cb8'] ||
                          this.characteristics['43312cd1-7d34-46ce-a7d3-0a98fd9b4cb8'];
    if (notifyAltChar) {
      await new Promise((resolve, reject) => {
        notifyAltChar.subscribe((err) => {
          if (err) {
            // Non-fatal, just log
            console.error('Failed to subscribe to notify_alt:', err.message);
            resolve();
            return;
          }
          notifyAltChar.on('data', (data) => {
            this.emit('event', data);
          });
          resolve();
        });
      });
    }
  }

  /**
   * Send initialization command (opcode 0x27)
   * This is sent right after subscribing, before auth
   */
  async _sendInitCommand() {
    // Command: seq=0, opcode=0x27, payload=[0x01, 0xC0, 0x03]
    // This appears to enable event notifications or set up the connection
    const initCmd = Buffer.from([0x00, 0x00, 0x27, 0x01, 0xC0, 0x03]);
    try {
      await this.sendCommand(initCmd, 2000);
    } catch (e) {
      // Non-fatal - some devices might not need this
    }
  }

  /**
   * Authenticate with device using challenge-response
   */
  async _authenticate() {
    // Step 1: Get protocol limits
    const limitsSeq = this._nextSeq();
    const limitsCmd = buildGetLimitsCommand(limitsSeq);
    const limitsResponse = await this.sendCommand(limitsCmd);

    const limitsResult = parseResponse(limitsResponse);
    if (limitsResult.status !== 0) {
      throw new Error(`Auth failed: could not get limits (status=${limitsResult.status})`);
    }

    // Parse limits: maxPayload (2 bytes), maxFiles (2 bytes), maxCmds (2 bytes)
    if (limitsResult.data && limitsResult.data.length >= 6) {
      this.maxPayload = limitsResult.data.readUInt16LE(0);
      this.maxFiles = limitsResult.data.readUInt16LE(2);
      this.maxCmds = limitsResult.data.readUInt16LE(4);
    }

    // Step 2: Request access seed (challenge)
    const seedSeq = this._nextSeq();
    const seedCmd = buildGetAccessSeedCommand(seedSeq);
    const seedResponse = await this.sendCommand(seedCmd);

    const seedResult = parseResponse(seedResponse);
    if (seedResult.status !== 0 || !seedResult.data || seedResult.data.length < 16) {
      throw new Error(`Auth failed: could not get access seed (status=${seedResult.status})`);
    }

    const accessSeed = seedResult.data.slice(0, 16);

    // Step 3: Compute auth token and send unlock command
    const authToken = createAuthToken(accessSeed);
    const unlockSeq = this._nextSeq();
    const unlockCmd = buildUnlockAccessCommand(unlockSeq, authToken);
    const unlockResponse = await this.sendCommand(unlockCmd);

    const unlockResult = parseResponse(unlockResponse);
    if (unlockResult.status !== 0) {
      throw new Error(`Auth failed: unlock rejected (status=${unlockResult.status})`);
    }

    this.authenticated = true;
  }

  /**
   * Get next sequence number (16-bit, wraps at 65535)
   */
  _nextSeq() {
    this.seq = (this.seq + 1) % 65535;
    return this.seq;
  }

  _onNotification(data) {
    // Sequence is 16-bit little-endian at bytes 0-1
    const seq = data.readUInt16LE(0);

    // Check for pending response
    const callback = this.pendingResponses.get(seq);
    if (callback) {
      callback(data);
      return;
    }

    // Emit as general notification
    this.emit('notification', data);
  }
}

// Singleton instance
let instance = null;
let currentFilter = null;

function getConnection(deviceFilter = 'proxy') {
  // If filter changed, create new instance
  if (!instance || currentFilter !== deviceFilter.toLowerCase()) {
    instance = new PuffcoConnection(deviceFilter);
    currentFilter = deviceFilter.toLowerCase();
  }
  return instance;
}

module.exports = { PuffcoConnection, getConnection };
