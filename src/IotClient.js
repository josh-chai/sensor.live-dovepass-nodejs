'strict'

const EventEmitter = require('events')
const aws_iot = require('aws-iot-device-sdk')

require('colors')

class IotClient extends EventEmitter {
    constructor(thing_name, { keys_path = {}, endpoint = '', port = '', debug = false }) {
        super()
        this.thing_name = thing_name
        this.client = aws_iot.thingShadow({
            ...keys_path,
            host: endpoint,
            port: port,
            debug: debug,
            clientId: `shadow-${this.thing_name}`
        })
        this.update_queue = []
        this.update_delay = 1000
        this.processEvents()
        this.processUpdateQueue()
    }
    register(next) {
        this.client.register(this.thing_name, next)
        this.client.subscribe(`@dovepass/things/${this.thing_name}/information/get`)
        this.client.on('message', (topic, message) => {
            let payload = JSON.parse(message.toString())
            if (topic.match(/^@dovepass\/things\/.*\/information\/get$/)) {
                let fields = payload.fields || []
                this.emit('request_information', topic, fields)
            }
        })
    }
    publish(topic, payload) {
        this.client.publish(topic, payload)
    }
    updateThingShadow(state) {
        this.update_queue.push(state)
    }
    processEvents() {
        this.client.on('connect', () => {
            this.emit('connect')
        })
        this.client.on('disconnect', () => {
            this.emit('connect')
        })
        this.client.on('close', () => {
            this.emit('close')
        })
        this.client.on('error', (error) => {
            this.emit('error', error)
        })
        this.client.on('delta', (thing_name, document) => {
            this.emit('delta', thing_name, document)
        })
        // more events
    }
    processUpdateQueue() {
        setInterval(() => {
            let state = this.update_queue.shift()
            if (state) {
                let client_token = this.client.update(this.thing_name, state)
                if (client_token === null) {
                    console.log('Update shadow failed, operation still in progress'.red)
                } else {
                    console.log('Update shadow success: ', `${JSON.stringify(state, null, 4)}`)
                }
            }
        }, this.update_delay)
    }
}

module.exports = IotClient
