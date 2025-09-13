#!/usr/bin/env node

/** Tiny tool for cleaning things up in mqtt retained messages.
Modify as needed for the case, run, move on. */

const mqtt = require('mqtt');
const fs = require('fs');
const yargs = require('yargs/yargs')
const { hideBin } = require('yargs/helpers')
const readline = require('node:readline');

const DIR = process.cwd();

const RECONNECT_PERIOD_DEFAULT = 1000; // default time until mqtt retries connecting
const RECONNECT_PERIOD_MAX = 20000;    // max retry time (after dynamic backoff)

let exit = () => {
  process.exit();
}

/** Wait for delay ms, for use in async functions. */
const wait = (delay) => new Promise((resolve) => { setTimeout(resolve, delay); });

const decodeJWT = (jwt) => JSON.parse(atob(jwt.split('.')[1]));

let MQTT_URL = process.env.MQTT_URL || 'mqtts://localhost';

/** set the title of the terminal we are running in */
const setTerminalTitle = (title) => {
  // Save title on stack:
  process.stdout.write('\033[22;0t');
  // set title:
  process.stdout.write('\033]0;' + title + '\007');

  const previousExit = exit;
  exit = () => {
    // Restore original title:
    process.stdout.write('\033[23;0t');
    previousExit();
  };

  process.on('SIGINT', function() {
    // redefine exit to also restore title
    exit();
  })
};

const prettyPayload = (string) => {
  try {
    const json = JSON.parse(string);
    return JSON.stringify(json, true, 2)
  } catch (e) {
    return string;
  }
};


setTerminalTitle('mqtt_tool');

const options = {
  rejectUnauthorized: false,
  protocolVersion: 5, // needed for the `rap` option, i.e., to get retain flags
};

if (MQTT_URL.startsWith('mqtts')) {
  try {
    options.key = fs.readFileSync('certs/client.key');
    options.cert = fs.readFileSync('certs/client.crt');
  } catch (e) {
    console.log('No certificates found, trying other methods');
  }
}

/** usage:
 MQTT_URL=ws://mqtt.localhost JWT='....' ./index.js sub .. */
if (process.env.JWT) {
  const payload = decodeJWT(process.env.JWT);
  console.log('using JWT', payload);
  const id = payload.id;
  options.username = JSON.stringify({id, payload});
  options.password = process.env.JWT;
}

if (!process.env.MQTT_URL && !options.key && !options.username) {
  /* Neither certificates, nor a JWT was provided, try "capability mode". In
  this mode we try to connect to the local mqtt broker run by the robot-agent. For
  that we look for a Transitive capability in the local folder and try to
  authenticate as that. */
  const package = require(`${DIR}/package.json`);
  if (!package) {
    console.error('No authentication method found');
    process.exit(1);
  }
  MQTT_URL = 'mqtt://localhost';
  const versionLengthByLevel = { major: 1, minor: 2, patch: 3 };
  const versionLength = versionLengthByLevel[package.config?.versionNamespace || 'patch'];
  const versionNS = package.version.split('.').slice(0, versionLength).join('.');

  options.clientId = `${package.name}/${versionNS}`;
  options.password =
    fs.readFileSync(`${process.env.HOME}/.transitive/packages/${package.name}/password`, 'utf8');
  options.username = JSON.stringify({version: package.version});
  // the Aedes mqtt broker run by the robot-agent doesn't use version 5:
  delete options.protocolVersion;
  console.log('Trying to connect to local capability');
}

/** Implement dynamic backoff when we fail to connect. */
let reconnectPeriod = RECONNECT_PERIOD_DEFAULT; // default to start with
const transformWsUrl = (url, options, client) => {
  options.reconnectPeriod = reconnectPeriod;
  console.log(`reconnect in ${options.reconnectPeriod} s`);
  return url;
}
options.transformWsUrl = transformWsUrl;

const mqttClient = mqtt.connect(MQTT_URL, options);

mqttClient.on('close', () => {
  console.warn('closed');
  if (reconnectPeriod < RECONNECT_PERIOD_MAX ) reconnectPeriod *= 2;
});

mqttClient.on('disconnect', console.log);

mqttClient.once('connect', () => {
  console.log('connected to mqtt broker');
  reconnectPeriod = RECONNECT_PERIOD_DEFAULT; // reset to default after a successful connection

  yargs(hideBin(process.argv))

    .command('sub [topic]', 'subscribe to a (set of) topic(s) and print to console',
      (yargs) => {
        return yargs
          .positional('topic', {
            describe: 'topic selector (using + and # wild-cards if you want)',
            default: '#'
          })
      }, (argv) => {
        if (argv.verbose) console.info(`subscribing to: ${argv.topic}`)

        mqttClient.on('message', (topic, payload, packet) => {
          console.log(topic,
            argv.verbose ? ( payload.length > 0 ?
              //JSON.stringify(JSON.parse(payload.toString()), true, 2)
              JSON.stringify(JSON.parse(payload.toString()))
              // payload.toString()
              : null )
            : '',
            argv.verbose ? packet.retain : ''
          );
        });
        mqttClient.subscribe(argv.topic, {rap: true}, argv.verbose && console.log);
        setTerminalTitle(`mqtt_tool sub ${argv.topic}`);
      })

    .command('clear topic', 'clear any retained messages on topic',
      (yargs) => {
        return yargs
          .positional('topic', {
            describe: 'topic selector (using + and # wild-cards if you want)'
          })
      }, (argv) => {
        if (argv.verbose) console.info(`subscribing to: ${argv.topic}`)

        mqttClient.on('message', (topic, payload, packet) => {
          if (payload && packet.retain) {
            mqttClient.publish(topic, null, {retain: packet.retain});
            argv.verbose && console.log('cleared', topic);
          }
        });
        mqttClient.subscribe(argv.topic, argv.verbose && console.log);
      })

    .command('purge [file]', 'clear topics listed in file without subscribing',
      (yargs) => {
        return yargs
          .positional('file', {
            describe: 'a filename listing topics to clear, one per line',
          })
      }, (argv) => {
        const input = argv.file?.length > 0 ?
          fs.createReadStream(argv.file, {encoding: 'utf8'}) :
          process.stdin;
        const rl = readline.createInterface({input});

        // rl.on('line', (topic) => {
        //   mqttClient.publish(topic.trim(), null, {retain: true});
        //   argv.verbose && console.log('cleared', topic);
        // });
        // rl.on('close', () => process.exit(0));
        const topics = [];
        rl.on('line', t => topics.push(t));
        rl.on('close', async () => {
          for (const topic of topics) {
            mqttClient.publish(topic.trim(), null, {retain: true});
            argv.verbose && console.log('cleared', topic);
            // throttle, to avoid max emitter error
            await wait(0.05);
          }
          process.exit(0);
        });
      })

    .command('pub topic message', 'publish message on topic',
      (yargs) => {
        return yargs
          .positional('topic', {
            describe: 'topic to publish to',
            default: ''
          })
          .positional('message', {
            describe: 'message to send',
            default: ''
          })
          .option('retain', {
            alias: 'r',
            type: 'boolean',
            description: 'Publish the message with retain flag set'
          })
          .option('raw', {
            alias: 'a',
            type: 'boolean',
            description: 'Publish value raw, do not JSON.stringify it.'
          })

      }, (argv) => {
        const payload = argv.raw ? argv.message : JSON.stringify(argv.message);
        mqttClient.publish(argv.topic, payload,
          {retain: argv.retain},
          () => setTimeout(() => process.exit(0), 200));
      })

    .command('backup [topic]', 'create a backup of the given topic',
      (yargs) => {
        return yargs
          .positional('topic', {
            describe: 'topic selector (using + and # wild-cards if you want)',
            default: '#'
          })
      }, (argv) => {
        if (argv.verbose) console.info(`subscribing to: ${argv.topic}`)

        const fd = fs.openSync('backup.json', 'w');
        mqttClient.on('message', (topic, payload, packet) => {
          argv.verbose && console.log('backing up', topic);
          packet.payload = payload.toString('base64');
          fs.writeSync(fd, JSON.stringify(packet) + '\n');
        });
        mqttClient.subscribe(argv.topic, {rap: true}, argv.verbose && console.log);
        setTerminalTitle(`mqtt_tool backup ${argv.topic}`);
      })

    .command('restore [file]', 'Restore from a backup file or stdin if omitted',
      (yargs) => yargs.positional('file', {
        describe: 'file to restore from',
        default: ''
      }),
      (argv) => {
        setTerminalTitle(`mqtt_tool restore`);

        const input = argv.file.length > 0 ?
          fs.createReadStream(argv.file, {encoding: 'utf8'}) :
          process.stdin;
        const rl = readline.createInterface({input});

        rl.on('line', (line) => {
          const data = JSON.parse(line);
          mqttClient.publish(data.topic, Buffer.from(data.payload, 'base64'),
            {retain: data.retain});
          argv.verbose && console.log('restoring', data.topic);
        });
        rl.on('close', () => process.exit(0));
      })

    .command('stress [rate]',
      'Stress the broker with rate publications per second (please use responsibly)',
      (yargs) => yargs.positional('rate', {
        describe: 'number of publications per second',
        default: '100'
      }),
      (argv) => {
        setTerminalTitle(`mqtt_tool stress`);

        const topic = `/stress/${process.pid}`;

        mqttClient.on('message', () => {
          argv.verbose && process.stdout.write('.');
        });
        mqttClient.subscribe(topic, {rap: true}, argv.verbose && console.log);

        const rate = Number(argv.rate);
        setInterval(() => {
            mqttClient.publish(topic, String(Date.now()), {retain: false});
          }, 1000/rate);
      })

    .middleware([argv => {
      if ('batch' in argv) {
        setTimeout(() => exit(), argv.batch || 100);
      }
    }])
    .demandCommand(1, 'Please specify a command.')
    .option('verbose', {
      alias: 'v',
      type: 'boolean',
      description: 'Run with verbose logging'
    })
    .option('batch', {
      alias: 'b',
      type: 'number',
      description: 'Stop after a short period (in ms). Useful for batching.'
    }).argv;

});
