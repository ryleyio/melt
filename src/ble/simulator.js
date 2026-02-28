/**
 * Claude Mode - Puffco Simulator
 * For when you want to take virtual dabs
 */

const EventEmitter = require('events');

// Simulated device state
const state = {
  battery: 87,
  heaterTemp: 72,
  heaterState: { code: 0, name: 'IDLE' },
  dabCount: 420,
  firmwareGit: 'CLAUDE-MODE',
  deviceName: 'Virtual Proxy 🤖',
  profiles: [
    { name: 'chill', temp: 490, time: 10, color: 0x00FF00, intensity: 0 },
    { name: 'terpy', temp: 520, time: 10, color: 0x00FFFF, intensity: 1 },
    { name: 'cloudy', temp: 550, time: 10, color: 0xFF00FF, intensity: 2 },
    { name: 'ripper', temp: 580, time: 10, color: 0xFF0000, intensity: 3 }
  ],
  currentProfile: 0,
  targetTemp: 0,
  heating: false,
  heatStartTime: null
};

class SimulatedConnection extends EventEmitter {
  constructor() {
    super();
    this.connected = false;
    this.authenticated = true;
  }

  async connect() {
    // Simulate connection delay
    await sleep(800);
    this.connected = true;
    this.emit('connected');
  }

  async disconnect() {
    this.connected = false;
    state.heating = false;
    state.heaterState = { code: 0, name: 'IDLE' };
    this.emit('disconnected');
  }

  getDeviceName() {
    return state.deviceName;
  }
}

class SimulatedCommands {
  constructor(connection) {
    this.connection = connection;
    this.heatInterval = null;
  }

  async getStatus() {
    await sleep(100);
    return {
      battery: state.battery,
      heaterTemp: state.heaterTemp,
      heaterState: state.heaterState,
      dabCount: state.dabCount,
      firmwareGit: state.firmwareGit
    };
  }

  async getHeaterTemp() {
    await sleep(50);
    return state.heaterTemp;
  }

  async getHeaterState() {
    await sleep(50);
    return state.heaterState;
  }

  async getBattery() {
    await sleep(50);
    return state.battery;
  }

  async getProfile(index) {
    await sleep(100);
    return state.profiles[index] || state.profiles[0];
  }

  async getAllProfiles() {
    await sleep(200);
    return state.profiles;
  }

  async startHeatProfile(profileIndex = 0) {
    const profile = state.profiles[profileIndex] || state.profiles[0];
    state.currentProfile = profileIndex;
    state.targetTemp = profile.temp;
    state.heating = true;
    state.heatStartTime = Date.now();
    state.heaterState = { code: 7, name: 'HEAT_PREHEAT' };

    // Simulate heating curve
    this.heatInterval = setInterval(() => {
      if (!state.heating) {
        clearInterval(this.heatInterval);
        return;
      }

      const elapsed = (Date.now() - state.heatStartTime) / 1000;
      const heatRate = 100; // degrees per second (fast for simulation)

      // Simulate heating with some randomness
      const targetDelta = state.targetTemp - 72; // room temp baseline
      const progress = Math.min(1, elapsed * heatRate / targetDelta);
      const noise = (Math.random() - 0.5) * 3;

      state.heaterTemp = Math.round(72 + (targetDelta * progress) + noise);
      state.heaterTemp = Math.min(state.heaterTemp, state.targetTemp + 5);

      // State transitions
      if (state.heaterTemp >= state.targetTemp - 5 && state.heaterState.code === 7) {
        state.heaterState = { code: 8, name: 'HEAT_ACTIVE' };
      }
    }, 200);

    await sleep(100);
  }

  async stopHeat() {
    state.heating = false;
    if (this.heatInterval) {
      clearInterval(this.heatInterval);
    }
    state.heaterState = { code: 9, name: 'HEAT_FADE' };

    // Simulate cooldown
    const cooldown = setInterval(() => {
      state.heaterTemp = Math.max(72, state.heaterTemp - 15);
      if (state.heaterTemp <= 100) {
        state.heaterState = { code: 0, name: 'IDLE' };
        clearInterval(cooldown);
      }
    }, 500);

    await sleep(100);
  }
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Singleton
let simConnection = null;

function getSimulatedConnection() {
  if (!simConnection) {
    simConnection = new SimulatedConnection();
  }
  return simConnection;
}

module.exports = {
  SimulatedConnection,
  SimulatedCommands,
  getSimulatedConnection
};
