'strict'

const EventEmitter = require('events')
const aws_iot = require('aws-iot-device-sdk')

require('colors')

let operations = [
    'UpdateConnection',
    'DeleteConnection',
    'SetSchedule',
    'DeleteSchedule',
    'SetRule',
    'DeleteRule'
]

class JobsClient extends EventEmitter {
    constructor(thing_name, { keys_path = {}, endpoint = '', port = '', debug = false }) {
        super()
        this.thing_name = thing_name
        this.client = aws_iot.jobs({
            ...keys_path,
            host: endpoint,
            port: port,
            debug: debug,
            clientId: `jobs-${this.thing_name}`
        })
        this.processEvents()
    }
    start(next) {
        this.client.startJobNotifications(this.thing_name, (error) => {
            if (error) {
                console.log('Start job notification error '.red, error)
            }
            next()
        })
        this.client.subscribeToJobs(this.thing_name, async(error, job) => {
            if (error) {
                console.log('Subscribe job error', error)
            } else {
                let document = job.document || {}
                let operation = document.operation
                let config = document.config || {}
                if (operations.indexOf(operation) > -1) {
                    job.inProgress({
                        operation,
                        step: 'Received job'
                    }, (error) => {
                        if (error) {
                            console.log(`Operation: ${operation} in progress error \n ${error}`.red)
                        }
                    })
                } else {
                    job.failed({
                        operation,
                        step: 'Unknow job'
                    }, (error) => {
                        if (error) {
                            console.log(`Operation: ${operation} reject error \n ${error}`.red)
                        }
                    })
                }
                this.emit(operation, config, (status) => {
                    if (status) {
                        job.succeeded({
                            operation,
                            step: 'Success'
                        }, (error) => {
                            if (error) {
                                console.log(`Operation: ${operation} success error \n ${error}`.red)
                            }
                        })
                    } else {
                        job.failed({
                            operation,
                            step: 'Failed'
                        }, (error) => {
                            if (error) {
                                console.log(`Operation: ${operation} failed error \n ${error}`.red)
                            }
                        })
                    }
                })
            }
        })
    }
    processEvents() {
        this.client.on('connect', () => {
            this.emit('connect')
        })
        this.client.on('close', () => {
            this.emit('close')
        })
        this.client.on('reconnect', () => {
            this.emit('reconnect')
        })
        this.client.on('offline', () => {
            this.emit('offline')
        })
        this.client.on('error', (error) => {
            this.emit('error', error)
        })
    }
}

module.exports = JobsClient
