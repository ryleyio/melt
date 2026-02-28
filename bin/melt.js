#!/usr/bin/env node

/**
 * MELT - Full Melt Hash Control
 * Terminal-based Puffco controller
 */

const { program } = require('commander');
const chalk = require('chalk');
const ora = require('ora');

const {
  getLogo,
  getLogoMini,
  batteryBar,
  tempBar,
  stateLabel,
  heatCurve,
  box,
  meltGradient,
  heatGradient
} = require('../src/ui/ascii');

const { getConnection } = require('../src/ble/connection');
const PuffcoCommands = require('../src/ble/commands');

// ═══════════════════════════════════════════════════════════════
// State
// ═══════════════════════════════════════════════════════════════

let connection = null;
let commands = null;

// ═══════════════════════════════════════════════════════════════
// CLI
// ═══════════════════════════════════════════════════════════════

program
  .name('melt')
  .description('Full melt hash control')
  .version('1.0.0')
  .option('-d, --device <name>', 'device to connect to (proxy, peak)', 'proxy');

// ═══════════════════════════════════════════════════════════════
// Connect
// ═══════════════════════════════════════════════════════════════

async function connect(spinner, deviceFilter = 'proxy') {
  if (connection?.connected) return true;

  connection = getConnection(deviceFilter);
  commands = new PuffcoCommands(connection);

  try {
    await connection.connect();
    if (spinner) spinner.succeed(chalk.green('connected'));
    return true;
  } catch (err) {
    if (spinner) spinner.fail(chalk.red('connection failed'));
    return false;
  }
}

// ═══════════════════════════════════════════════════════════════
// Status
// ═══════════════════════════════════════════════════════════════

program
  .command('status')
  .alias('s')
  .description('Device status')
  .action(async () => {
    const opts = program.opts();
    console.log();
    const spinner = ora({ text: 'connecting...', color: 'cyan' }).start();

    if (!await connect(spinner, opts.device)) {
      process.exit(1);
    }

    try {
      const status = await commands.getStatus();
      const deviceName = connection.getDeviceName();

      console.log();
      console.log(meltGradient(`  ${deviceName}`));
      console.log();
      console.log(`  battery   ${batteryBar(status.battery)}`);
      console.log(`  temp      ${chalk.white(status.heaterTemp + '°F')} ${stateLabel(status.heaterState.code, status.heaterState.name)}`);
      console.log(`  dabs      ${chalk.cyan(status.dabCount)}`);
      console.log(`  firmware  ${chalk.gray(status.firmwareGit)}`);
      console.log();

      await connection.disconnect();
      process.exit(0);
    } catch (err) {
      console.error(chalk.red(`\n  error: ${err.message}\n`));
      process.exit(1);
    }
  });

// ═══════════════════════════════════════════════════════════════
// Heat
// ═══════════════════════════════════════════════════════════════

program
  .command('heat [profile]')
  .alias('h')
  .description('Start heat cycle (profile 0-3)')
  .action(async (profileArg) => {
    const opts = program.opts();
    const profileIndex = parseInt(profileArg) || 0;

    console.log();
    const spinner = ora({ text: 'connecting...', color: 'cyan' }).start();

    if (!await connect(spinner, opts.device)) {
      process.exit(1);
    }

    try {
      // Get profile info
      const profile = await commands.getProfile(profileIndex);
      const targetTemp = profile.temp;
      const duration = profile.time;

      console.log();
      console.log(meltGradient(`  ${profile.name}`));
      console.log(chalk.gray(`  ${targetTemp}°F · ${duration}s`));
      console.log();

      // Start heating
      await commands.startHeatProfile(profileIndex);

      // Monitor
      const temps = [];
      let reachedTarget = false;
      let consecutiveErrors = 0;

      const monitor = setInterval(async () => {
        try {
          const temp = await commands.getHeaterTemp();
          const state = await commands.getHeaterState();
          consecutiveErrors = 0;

          temps.push(temp);

          const bar = tempBar(temp, targetTemp, 30);
          const pct = Math.min(100, Math.round((temp / targetTemp) * 100));

          process.stdout.write(`\r  ${bar} ${chalk.white(temp + '°F')} ${chalk.gray(pct + '%')} ${stateLabel(state.code, state.name)}   `);

          // Reached target
          if ((state.code === 8 || temp >= targetTemp - 5) && !reachedTarget) {
            reachedTarget = true;
            clearInterval(monitor);

            console.log();
            console.log();
            console.log(heatGradient(`  ✓ ready`));
            console.log();

            // Countdown
            let remaining = duration;
            const countdown = setInterval(async () => {
              remaining--;
              process.stdout.write(`\r  ${chalk.cyan(remaining + 's')} remaining   `);

              if (remaining <= 0) {
                clearInterval(countdown);
                console.log();
                console.log();
                console.log(chalk.green('  ✓ session complete'));
                console.log();

                if (temps.length > 5) {
                  console.log(chalk.gray('  heat curve:'));
                  console.log(heatCurve(temps, 35, 6));
                  console.log();
                }

                await connection.disconnect();
                process.exit(0);
              }
            }, 1000);
          }

          // Check if stopped
          const isHeating = [7, 8, 9].includes(state.code);
          if (!isHeating && temps.length > 10) {
            clearInterval(monitor);
            console.log();
            console.log();
            console.log(chalk.yellow(`  stopped (${state.name.toLowerCase()})`));
            console.log();
            await connection.disconnect();
            process.exit(0);
          }

        } catch (err) {
          consecutiveErrors++;
          if (consecutiveErrors >= 5) {
            clearInterval(monitor);
            console.log();
            console.log(chalk.red('\n  connection lost\n'));
            process.exit(1);
          }
        }
      }, 1000);

      // Ctrl+C
      process.on('SIGINT', async () => {
        clearInterval(monitor);
        console.log();
        console.log(chalk.yellow('\n  stopping...\n'));
        try { await commands.stopHeat(); } catch (e) {}
        await connection.disconnect();
        process.exit(0);
      });

    } catch (err) {
      console.error(chalk.red(`\n  error: ${err.message}\n`));
      process.exit(1);
    }
  });

// ═══════════════════════════════════════════════════════════════
// Profiles
// ═══════════════════════════════════════════════════════════════

program
  .command('profiles')
  .alias('p')
  .description('List heat profiles')
  .action(async () => {
    const opts = program.opts();
    console.log();
    const spinner = ora({ text: 'connecting...', color: 'cyan' }).start();

    if (!await connect(spinner, opts.device)) {
      process.exit(1);
    }

    try {
      const profiles = await commands.getAllProfiles();

      console.log();
      console.log(meltGradient('  profiles'));
      console.log();

      const colors = [chalk.green, chalk.cyan, chalk.magenta, chalk.red];

      profiles.forEach((p, i) => {
        const c = colors[i];
        const name = (p.name || `Profile ${i}`).padEnd(16);
        const temp = (p.temp + '°F').padStart(6);
        const time = (p.time + 's').padStart(4);
        console.log(`  ${c('●')} ${chalk.white(name)} ${chalk.gray(temp)} ${chalk.gray(time)}`);
      });

      console.log();
      console.log(chalk.gray('  usage: melt heat 0'));
      console.log();

      await connection.disconnect();
      process.exit(0);
    } catch (err) {
      console.error(chalk.red(`\n  error: ${err.message}\n`));
      process.exit(1);
    }
  });

// ═══════════════════════════════════════════════════════════════
// Stop
// ═══════════════════════════════════════════════════════════════

program
  .command('stop')
  .alias('x')
  .description('Stop heat cycle')
  .action(async () => {
    const opts = program.opts();
    console.log();
    const spinner = ora({ text: 'connecting...', color: 'cyan' }).start();

    if (!await connect(spinner, opts.device)) {
      process.exit(1);
    }

    try {
      await commands.stopHeat();
      console.log(chalk.green('\n  ✓ stopped\n'));
      await connection.disconnect();
      process.exit(0);
    } catch (err) {
      console.error(chalk.red(`\n  error: ${err.message}\n`));
      process.exit(1);
    }
  });

// ═══════════════════════════════════════════════════════════════
// Reset
// ═══════════════════════════════════════════════════════════════

program
  .command('reset')
  .alias('r')
  .description('Reset connection')
  .action(async () => {
    const { execSync } = require('child_process');

    console.log(chalk.yellow('\n  resetting...\n'));

    try {
      execSync('pkill -f "melt.js" 2>/dev/null || true', { stdio: 'ignore' });
      execSync('pkill -f "proxy.js" 2>/dev/null || true', { stdio: 'ignore' });
    } catch (e) {}

    await new Promise(r => setTimeout(r, 500));

    console.log(chalk.green('  ✓ reset complete\n'));
    console.log(chalk.gray('  wake your device and try again\n'));

    process.exit(0);
  });

// ═══════════════════════════════════════════════════════════════
// Default (show logo + help)
// ═══════════════════════════════════════════════════════════════

if (process.argv.length === 2) {
  console.log(getLogo());
  console.log(chalk.white('  commands:'));
  console.log();
  console.log(`  ${chalk.cyan('melt status')}     device status`);
  console.log(`  ${chalk.cyan('melt heat 0')}     heat with profile 0`);
  console.log(`  ${chalk.cyan('melt profiles')}   list profiles`);
  console.log(`  ${chalk.cyan('melt stop')}       stop heating`);
  console.log(`  ${chalk.cyan('melt reset')}      fix connection`);
  console.log();
  console.log(chalk.white('  options:'));
  console.log();
  console.log(`  ${chalk.cyan('-d, --device')}    device name ${chalk.gray('(proxy, peak)')}`);
  console.log();
  console.log(chalk.gray('  example: melt -d peak status'));
  console.log();
  process.exit(0);
}

program.parse();
