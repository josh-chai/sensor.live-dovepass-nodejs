'strict'

const Modbus = require('jsmodbus')
const net = require('net')
const asyncForEach = require('../utils/AsyncForEach')
const encoders = require('../../Encoders')
const decoders = require('../../Decoders')

const functions = {
    '0x01': 'readCoils',
    '0x02': 'readDiscreteInputs',
    '0x03': 'readHoldingRegisters',
    '0x04': 'readInputRegisters',
    '0x05': 'writeSingleCoil',
    '0x06': 'writeSingleRegister',
    '0x0F': 'writeMultipleCoils',
    '0x10': 'writeMultipleRegisters'
}

class ModbusTCP {
    constructor(config) {
        this.config = config
        this.nodes = {}
        this.clients = {}
        this.socket = null
        this.initialize()
    }
    initialize() {
        let options = {
           host: this.config.host,
           port: this.config.port
        }
        let poll_timeout = parseInt(this.config.poll_timeout) || 5000
        let reconnect_timeout = parseInt(this.config.reconnect_timeout) || 3000
        console.log(`[Modbus TCP connecting]\tName: ${this.config.name}\tHost: ${this.config.host}\tPort: ${this.config.port}`)
        this.socket = new net.Socket()
        this.socket.setTimeout(poll_timeout)
        this.socket.connect(options)
        this.socket.on('connect', () => {
            console.log(`[Modbus TCP connected]\tName: ${this.config.name}\tHost: ${this.config.host}\tPort: ${this.config.port}`)
            setTimeout(() => {
                this.scan()
            }, 1000)
        })
        this.socket.on('error', (error) => {
            console.log(`[Modbus TCP connection error]\tName: ${this.config.name}\tHost: ${this.config.host}\tPort: ${this.config.port}\t${error}`)
        })
        this.socket.on('close', () => {
            console.log(`[Modbus TCP connection close]\tName: ${this.config.name}\tHost: ${this.config.host}\tPort: ${this.config.port}`)
            if (this.config.auto_reconnect) {
                setTimeout(() => {
                    console.log(`[Modbus TCP reconnect]\tName: ${this.config.name}\tHost: ${this.config.host}\tPort: ${this.config.port}`)
                    this.socket.connect(options)
                }, reconnect_timeout)
            }
        })
        this.config.devices.forEach(device => {
            this.clients[device.slave_id] = new Modbus.client.TCP(this.socket, device.slave_id)
            device.nodes.forEach(node => {
                let readable = parseInt(node.function_code, 16) < 5
                this.nodes[`${this.config.name}-${device.slave_id}-${node.property}-${readable ? 'read' : 'write'}`] = node
            })
        })
    }
    async desired(state, is_local) {
        let dataset = {}
        for (let key in state) {
            let node = this.nodes[`${key}-write`]
            if (!node) {
                console.log(`Desire node[${key}] not exists`)
                continue
            }
            let slave_id = key.replace(/^[^-]*-([^-]*)-.*/, '$1')
            let value = state[key]
            let write_function_code = node.write.function_code
            let write_address = parseInt(node.write.address)
            let encoder = 'set' + node.property.replace(/[-_]/g, ' ').replace(/^([a-z])|\s+([a-z])/g, ($1) => {
                return $1.toUpperCase()
            }).replace(/\x20/g, '')
            if (typeof encoders[encoder] === 'function') {
                value = encoders[encoder](value) || value
            }
            value = parseInt(value)
            await (() => {
                return new Promise((resolve, reject) => {
                    this.clients[slave_id][functions[write_function_code]](write_address, value).then(result => {
                        resolve(result)
                    }).catch(error => {
                        reject(error)
                    })
                })
            })().then(result => {
                dataset[`${this.config.name}-${slave_id}-${node.property}`] = value
            }, error => {
                console.log(`[Modbus TCP Write Error]\tName: ${this.config.name}\tHost: ${this.config.host}\tPort: ${this.config.port}\t${error.message}`)
            })
        }
        if (Object.keys(dataset).length > 0) {
            process.send({
                command: is_local ? 'shadow_reported' : 'shadow_clear_delta',
                payload: dataset
            })
        }
    }
    async scan() {
        let dataset = {}
        await this.config.devices.asyncForEach(async(device) => {
            await device.nodes.asyncForEach(async(node) => {
                let read_function_code = node.read.function_code
                let read_address = parseInt(node.read.address)
                let read_quantity = parseInt(node.read.quantity)
                await (() => {
                    return new Promise((resolve, reject) => {
                        this.clients[device.slave_id][functions[read_function_code]](read_address, read_quantity).then(result => {
                            resolve(result.response._body.valuesAsArray)
                        }).catch(error => {
                            reject(error)
                        })
                    })
                })().then(result => {
                    if (read_quantity === 1) {
                        result = result[0]
                    }
                    let decoder = 'get' + node.property.replace(/[-_]/g, ' ').replace(/^([a-z])|\s+([a-z])/g, ($1) => {
                        return $1.toUpperCase()
                    }).replace(/\x20/g, '')
                    if (typeof decoders[decoder] === 'function') {
                        result = decoders[decoder](result) || result
                    }
                    dataset[`${this.config.name}-${device.slave_id}-${node.property}`] = result
                }, error => {
                    console.log(`[Modbus TCP Scan Error]\tName: ${this.config.name}\tHost: ${this.config.host}\tPort: ${this.config.port}\t${error.message}`)
                })
            })
        })
        if (Object.keys(dataset).length > 0) {
            process.send({
                command: 'shadow_reported',
                payload: dataset
            })
        }
        let poll_rate = parseInt(this.config.poll_rate) || 5000
        setTimeout(() => {
            this.scan()
        }, poll_rate)
    }
    terminate(next) {
        this.socket.end()
        next()
    }
}

module.exports = ModbusTCP
