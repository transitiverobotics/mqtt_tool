#!/usr/bin/env node

/** Tiny tool for cleaning things up in mqtt retained messages.
Modify as needed for the case, run, move on. */

const mqtt = require('mqtt');
const fs = require('fs');
const yargs = require('yargs/yargs')
const { hideBin } = require('yargs/helpers')
const readline = require('node:readline');

let exit = () => {
  process.exit();
}

MQTT_URL = process.env.MQTT_URL || 'mqtts://localhost';

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

setTerminalTitle('mqtt_tool');

const options = {
  rejectUnauthorized: false,
  protocolVersion: 5 // needed for the `rap` option, i.e., to get retain flags
};

if (MQTT_URL.startsWith('mqtts')) {
  options.key = fs.readFileSync('certs/client.key');
  options.cert = fs.readFileSync('certs/client.crt');
}

const mqttClient = mqtt.connect(MQTT_URL, options);

mqttClient.on('error', console.log);
mqttClient.on('disconnect', console.log);

mqttClient.on('connect', () => {
  console.log('connected to mqtt broker');

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
          // console.log(`${topic}${argv.verbose ? ' ' +
          //     JSON.stringify(JSON.parse(payload.toString()), true, 2)
          //   : ''}`);
          console.log(topic,
            argv.verbose ?
            (payload.length > 0 ? JSON.parse(payload.toString()) : null)
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
