'strict'

const ModbusSerial = require('modbus-serial')
const asyncForEach = require('../utils/AsyncForEach')
const encoders = require('../../Encoders')
const decoders = require('../../Decoders')

const functions = {
    '0x01': 'readCoils',
    '0x02': 'readDiscreteInputs',
    '0x03': 'readHoldingRegisters',
    '0x04': 'readInputRegisters',
    '0x05': 'writeCoil',
    '0x06': 'writeRegister',
    '0x0F': 'writeCoils',
    '0x10': 'writeRegisters'
}

class ModbusRTU {
    constructor(config) {
        this.config = config
        this.nodes = {}
        this.client = {}
        this.initialize()
        this.retry_interval = null
    }
    initialize() {
        let options = {
            baudRate: this.config.baud_rate,
            parity: this.config.parity,
            databits: this.config.data_bits,
            stopbits: this.config.stop_bits
        }
        let poll_timeout = parseInt(this.config.poll_timeout) || 5000
        let reconnect_timeout = parseInt(this.config.reconnect_timeout) || 3000
        console.log(`[Modbus RTU connecting]\tName: ${this.config.name}\tPort: ${this.config.serial_port}\tBaudRate: ${this.config.baud_rate}`)
        this.client = new ModbusSerial()
        this.client.connectRTU(this.config.serial_port, options, (error) => {
            this.client.setTimeout(poll_timeout)
            if (error) {
                console.log(`[Modbus RTU connect failed]\tName: ${this.config.name}\tPort: ${this.config.serial_port}\tBaudRate: ${this.config.baud_rate}`)
                if (this.config.auto_reconnect) {
                    setTimeout(() => {
                        this.initialize()
                    }, reconnect_timeout)
                }
                return
            }
            console.log(`[Modbus RTU connected]\tName: ${this.config.name}\tPort: ${this.config.serial_port}\tBaudRate: ${this.config.baud_rate}`)
            this.scan()
        })
        this.client._port.on('open', () => {
            if (this.retry_interval) {
                clearInterval(this.retry_interval)
                this.retry_interval = null
            }
        })
        this.client._port.on('close', () => {
            if (!this.retry_interval && this.config.auto_reconnect) {
                this.retry_interval = setInterval(() => {
                    this.client._port.open()
                }, reconnect_timeout)
            }
        })
        this.client._port.on('error', (error) => {
            // console.log(error)
        })
        this.config.devices.forEach(device => {
            device.nodes.forEach(node => {
                let readable = parseInt(node.function_code, 16) < 5
                this.nodes[`${this.config.name}-${device.slave_id}-${node.property}-${readable ? 'read' : 'write'}`] = node
            })
        })
    }
    async desired(state, is_local) {
        let dataset = {}
        let desired_errors = []
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
                    if (this.client.getID() !== parseInt(slave_id)) {
                        this.client.setID(slave_id)
                    }
                    this.client[functions[write_function_code]](write_address, value).then(result => {
                        resolve(result)
                    }).catch(error => {
                        reject(error)
                    })
                })
            })().then(result => {
                dataset[`${this.config.name}-${slave_id}-${node.property}`] = value
            }, error => {
                desired_errors.push(console.log(`[Modbus RTU Write Error]\tName: ${this.config.name}\tPort: ${this.config.serial_port}\tBaudRate: ${this.config.baud_rate}\t${error.message}`))
            })
        }
        if (desired_errors.length > 0) {
            console.log(`[Modbus RTU Write Error]\tName: ${this.config.name}\tPort: ${this.config.serial_port}\tBaudRate: ${this.config.baud_rate}`)
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
        let scan_errors = []
        await this.config.devices.asyncForEach(async(device) => {
            this.client.setID(device.slave_id)
            await device.nodes.asyncForEach(async(node) => {
                let read_function_code = node.read.function_code
                let read_address = parseInt(node.read.address)
                let read_quantity = parseInt(node.read.quantity)
                await (() => {
                    return new Promise((resolve, reject) => {
                        this.client[functions[read_function_code]](read_address, read_quantity).then(result => {
                            resolve(result.data)
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
                    scan_errors.push(error)
                })
            })
        })
        if (scan_errors.length > 0) {
            console.log(`[Modbus RTU Scan Error]\tName: ${this.config.name}\tPort: ${this.config.serial_port}\tBaudRate: ${this.config.baud_rate}`)
        }
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
        if (this.retry_interval) {
            clearInterval(this.retry_interval)
            this.retry_interval = null
        }
        this.client.close(() => {
            next()
        })
    }
}

module.exports = ModbusRTU
