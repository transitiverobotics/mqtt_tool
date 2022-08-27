# MQTT Tool

A simple CLI tool for interacting with MQTT, pub, sub, clear, backup, restore.

## Install

```
npm install mqtt_tool
```
or globally by adding the `-g` flag (and possibly `sudo`)


## Usage

If the tool is globally installed, then you can run `mqtt_tool` directly and from anywhere in your file-tree. Otherwise you need to use `npx` locally:

```sh
> npx mqtt_tool --help
connected to mqtt broker
index.js <command>

Commands:
  index.js sub [topic]        subscribe to a (set of) topic(s) and print to
                              console
  index.js clear topic        clear any retained messages on topic
  index.js pub topic message  publish message on topic
  index.js backup [topic]     create a backup of the given topic
  index.js restore [file]     Restore from a backup file or stdin if omitted

Options:
      --help     Show help                                             [boolean]
      --version  Show version number                                   [boolean]
  -v, --verbose  Run with verbose logging                              [boolean]
  -b, --batch    Stop after a short period. Useful for batching.       [boolean]
```

Set your ENV variable `MQTT_URL` to the url of your mqtt broker. The default is `mqtts://localhost`. When using SSL, i.e., `mqtts://`, you need to have certificates in a sub-folder called `certs/`.


### Generating local dev certificates

When you run an MQTT broker with self-signed certificates, as is typical in development, you can generate client certificates for this tool like this:

```sh
openssl genrsa -out client.key 2048
openssl req -out client.csr -key client.key -new -subj="/CN=myName"
openssl x509 -req -in client.csr -CA PATH_TO/ca.crt -CAkey PATH_TO/ca.key -CAcreateserial -out client.crt -days 36500

echo "certificates generated for:"
openssl x509 -in client.crt -text | grep CN
```