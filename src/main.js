const cluster = require('cluster')
const util = require('util')
const fs = require('fs')
const fs_writeFile = util.promisify(fs.writeFile)
const aws_iot = require('aws-iot-device-sdk')
const thing_registry = require('sensor.live-things-registry')
const colors = require('colors')
const SerialPort = require('serialport')
const ModbusRTU = require('./ModbusRTU')
const ModbusTCP = require('./ModbusTCP')
const CronJob = require('cron').CronJob

const STORAGE_PATH = `${__dirname}/../storage`
const OPERATION_UPDATE_MODBUS_CONFIG = 'UpdateModbusConfig'
const OPERATION_REMOVE_MODBUS_CONFIG = 'RemoveModbusConfig'
const OPERATION_SET_SCHEDULE = 'SetSchedule'
const OPERATION_DELETE_SCHEDULE = 'DeleteSchedule'
const OPERATION_SET_RULE = 'SetRule'
const OPERATION_DELETE_RULE = 'DeleteRule'

const config = {
    aws_iot: {
        endpoint: 'axt811sti1q4w.iot.ap-northeast-1.amazonaws.com',
        port: '8883',
        debug: false
    }
}

if (cluster.isMaster) {
    class ModbusModulator {
        constructor() {
            this.jobs = null
            this.thing_shadow = null
            this.update_shadow_queue = []
            this.shadow_datasets = {}
            this.timers = {}
            this.schedules = {}
            this.rules = {}
            this.thing_name = 'RP1'
            this.keys_path = {}
        }
        async initialize() {
            await this.initCertificate()
            await this.initShadow()
            await this.processShadowQueue()
            await this.initCluster()
            await this.initSchedules()
            await this.initRules()
            await this.initJobs()
            await this.processDatasets()
            await this.processRules()
        }
        initCertificate() {
            thing_registry.setCertsPath('./certs')
            if (!thing_registry.hasDeviceCertificate()) {
                thing_registry.generateDeviceCertificate({
                    thing_name: this.thing_name
                })
            }
            this.keys_path = thing_registry.getKeysPath()
            console.log('IoT certificates is ready.'.green)
        }
        initJobs() {
            return new Promise(resolve => {
                this.jobs = aws_iot.jobs({
                    ...this.keys_path,
                    host: config.aws_iot.endpoint,
                    port: config.aws_iot.port,
                    debug: config.aws_iot.debug,
                    clientId: `job-${this.thing_name}`
                })
                this.jobs.on('connect', () => {
                    console.log('Jobs has connected'.green)
                    // this.jobs.subscribeToJobs(this.thing_name, (error, job) => {
                    //     if (error) {
                    //         console.error(error)
                    //     } else {
                    //         console.log(`Operation handler invoked, job ID: ${job.id.toString()}`)
                    //         console.log('Job document: ')
                    //         console.log(job.document)
                    //     }
                    // })
                    this.jobs.subscribeToJobs(this.thing_name, OPERATION_UPDATE_MODBUS_CONFIG, async(error, job) => {
                        if (error) {
                            console.error(error)
                        } else {
                            console.log(`Operation handler invoked, Job ID: ${job.id.toString()}`)
                            await job.inProgress({ operation: OPERATION_UPDATE_MODBUS_CONFIG, step: 'Received modbus config' }, (error) => {
                                if (error) {
                                    console.log(`Operation: ${OPERATION_UPDATE_MODBUS_CONFIG} update in progress error \n ${error}`.red)
                                    return
                                }
                            })
                            let saved = false
                            let config = job.document.modbus_config
                            let type = config.type || null
                            let name = config.name || null
                            if (!type || !name) {
                                await job.rejected({ operation: OPERATION_UPDATE_MODBUS_CONFIG, step: 'Modbus config invaild' }, (error) => {
                                    if (error) {
                                        console.log(`Operation: ${OPERATION_UPDATE_MODBUS_CONFIG} update rejected error \n ${error}`.red)
                                    }
                                    return
                                })
                            }
                            let file = `${STORAGE_PATH}/${type.toUpperCase()}-${name}.json`
                            await fs_writeFile(file, JSON.stringify(config, null, 4)).then(result => {
                                saved = true
                                console.log('Write modbus config success'.green)
                            }, error => {
                                console.log('Write modbus config error: ', error)
                            })
                            if (saved) {
                                let current_worker = null
                                for (let id in cluster.workers) {
                                    if (cluster.workers[id].name === config.name) {
                                        current_worker = cluster.workers[id]
                                    }
                                }
                                if (current_worker) {
                                    current_worker.send({
                                        command: 'terminate'
                                    })
                                }
                                // New worker
                                setTimeout(() => {
                                    let worker = cluster.fork()
                                    worker.on('online', () => {
                                        this.workerOnlineHandler(worker, config)
                                    })
                                    worker.on('message', (message) => {
                                        this.workerMessageHandler(worker, config, message)
                                    })
                                    worker.on('disconnect', this.workerDisconnectHandler)
                                }, 3000)
                            } else {
                                job.failed({ operation: OPERATION_UPDATE_MODBUS_CONFIG, step: 'Update failed' }, (error) => {
                                    if (error) {
                                        console.log(`Operation: ${OPERATION_UPDATE_MODBUS_CONFIG} update failed error \n ${error}`.red)
                                        return
                                    }
                                })
                            }
                            job.succeeded({ operation: OPERATION_UPDATE_MODBUS_CONFIG, step: 'Update success' }, (error) => {
                                if (error) {
                                    console.log(`Operation: ${OPERATION_UPDATE_MODBUS_CONFIG} update successed error \n ${error}`.red)
                                }
                            })
                        }
                    })
                    this.jobs.subscribeToJobs(this.thing_name, OPERATION_SET_SCHEDULE, async(error, job) => {
                        if (error) {
                            console.error(error)
                        } else {
                            console.log(`Operation handler invoked, Job ID: ${job.id.toString()}`)
                            await job.inProgress({ operation: OPERATION_SET_SCHEDULE, step: 'Received schedule' }, (error) => {
                                if (error) {
                                    console.log(`Operation: ${OPERATION_SET_SCHEDULE} update in progress error \n ${error}`.red)
                                    return
                                }
                            })
                            let saved = false
                            let schedule = job.document.schedule
                            let id = schedule.id || null
                            let pattern = schedule.pattern || null
                            if (!id || !pattern) {
                                await job.rejected({ operation: OPERATION_SET_SCHEDULE, step: 'Schedule invaild' }, (error) => {
                                    if (error) {
                                        console.log(`Operation: ${OPERATION_SET_SCHEDULE} update rejected error \n ${error}`.red)
                                    }
                                    return
                                })
                            }
                            let file = `${STORAGE_PATH}/Schedule-${id}.json`
                            await fs_writeFile(file, JSON.stringify(schedule, null, 4)).then(result => {
                                saved = true
                                console.log('Write schedule success'.green)
                            }, error => {
                                console.log('Write schedule error: ', error)
                            })
                            if (saved) {
                                this.restartSchedule(schedule).then(restarted => {
                                    this.reportSchedules()
                                    job.succeeded({ operation: OPERATION_SET_SCHEDULE, step: 'Set success' }, (error) => {
                                        if (error) {
                                            console.log(`Operation: ${OPERATION_SET_SCHEDULE} update successed error \n ${error}`.red)
                                        }
                                    })
                                }, error => {
                                    job.failed({ operation: OPERATION_DELETE_SCHEDULE, step: 'Set failed' }, (error) => {
                                        if (error) {
                                            console.log(`Operation: ${OPERATION_SET_SCHEDULE} update failed error \n ${error}`.red)
                                        }
                                    })
                                })
                            }
                        }
                    })
                    this.jobs.subscribeToJobs(this.thing_name, OPERATION_DELETE_SCHEDULE, async(error, job) => {
                        if (error) {
                            console.error(error)
                        } else {
                            console.log(`Operation handler invoked, Job ID: ${job.id.toString()}`)
                            await job.inProgress({ operation: OPERATION_DELETE_SCHEDULE, step: 'Received delete schedule' }, (error) => {
                                if (error) {
                                    console.log(`Operation: ${OPERATION_DELETE_SCHEDULE} update in progress error \n ${error}`.red)
                                }
                                return
                            })
                            let deleted = false
                            let schedule = job.document.schedule || {}
                            let id = schedule.id || null
                            let pattern = schedule.pattern || null
                            if (!id || !pattern) {
                                await job.rejected({ operation: OPERATION_DELETE_SCHEDULE, step: 'Schedule delete invaild' }, (error) => {
                                    if (error) {
                                        console.log(`Operation: ${OPERATION_DELETE_SCHEDULE} update rejected error \n ${error}`.red)
                                    }
                                    return
                                })
                            }
                            let file = `${STORAGE_PATH}/Schedule-${id}.json`
                            if (fs.existsSync(file)) {
                                fs.unlinkSync(file)
                                console.log('Delete schedule success'.green)
                            }
                            this.stopSchedule(schedule).then(stoped => {
                                this.reportSchedules()
                                job.succeeded({ operation: OPERATION_DELETE_SCHEDULE, step: 'Delete success' }, (error) => {
                                    if (error) {
                                        console.log(`Operation: ${OPERATION_DELETE_SCHEDULE} update successed error \n ${error}`.red)
                                    }
                                })
                            }, error => {
                                job.failed({ operation: OPERATION_DELETE_SCHEDULE, step: 'Delete failed' }, (error) => {
                                    if (error) {
                                        console.log(`Operation: ${OPERATION_DELETE_SCHEDULE} update failed error \n ${error}`.red)
                                    }
                                })
                            })
                        }
                    })
                    this.jobs.subscribeToJobs(this.thing_name, OPERATION_SET_RULE, async(error, job) => {
                        if (error) {
                            console.error(error)
                        } else {
                            console.log(`Operation handler invoked, Job ID: ${job.id.toString()}`)
                            await job.inProgress({ operation: OPERATION_SET_RULE, step: 'Received rule' }, (error) => {
                                if (error) {
                                    console.log(`Operation: ${OPERATION_SET_RULE} update in progress error \n ${error}`.red)
                                    return
                                }
                            })
                            let saved = false
                            let rule = job.document.rule
                            let id = rule.id || null
                            if (!id) {
                                await job.rejected({ operation: OPERATION_SET_RULE, step: 'Schedule invaild' }, (error) => {
                                    if (error) {
                                        console.log(`Operation: ${OPERATION_SET_RULE} update rejected error \n ${error}`.red)
                                    }
                                    return
                                })
                            }
                            let file = `${STORAGE_PATH}/Rule-${id}.json`
                            await fs_writeFile(file, JSON.stringify(rule, null, 4)).then(result => {
                                saved = true
                                console.log('Write rule success'.green)
                            }, error => {
                                console.log('Write rule error: ', error)
                            })
                            if (saved) {
                                this.addRule(rule)
                                job.succeeded({ operation: OPERATION_SET_RULE, step: 'Set success' }, (error) => {
                                    if (error) {
                                        console.log(`Operation: ${OPERATION_SET_RULE} update successed error \n ${error}`.red)
                                    }
                                })
                            } else {
                                job.failed({ operation: OPERATION_DELETE_RULE, step: 'Set failed' }, (error) => {
                                    if (error) {
                                        console.log(`Operation: ${OPERATION_SET_RULE} update failed error \n ${error}`.red)
                                    }
                                })
                            }
                        }
                    })
                    this.jobs.subscribeToJobs(this.thing_name, OPERATION_DELETE_RULE, async(error, job) => {
                        if (error) {
                            console.error(error)
                        } else {
                            console.log(`Operation handler invoked, Job ID: ${job.id.toString()}`)
                            await job.inProgress({ operation: OPERATION_DELETE_RULE, step: 'Received delete rule' }, (error) => {
                                if (error) {
                                    console.log(`Operation: ${OPERATION_DELETE_RULE} update in progress error \n ${error}`.red)
                                }
                                return
                            })
                            let deleted = false
                            let rule = job.document.rule
                            let id = rule.id || null
                            if (!id) {
                                await job.rejected({ operation: OPERATION_DELETE_RULE, step: 'Rule delete invaild' }, (error) => {
                                    if (error) {
                                        console.log(`Operation: ${OPERATION_DELETE_RULE} update rejected error \n ${error}`.red)
                                    }
                                    return
                                })
                            }
                            let file = `${STORAGE_PATH}/Rule-${id}.json`
                            if (fs.existsSync(file)) {
                                fs.unlinkSync(file)
                                console.log('Delete rule success'.green)
                                this.removeRule(rule)
                                job.succeeded({ operation: OPERATION_DELETE_RULE, step: 'Delete success' }, (error) => {
                                    if (error) {
                                        console.log(`Operation: ${OPERATION_DELETE_RULE} update successed error \n ${error}`.red)
                                    }
                                })
                            } else {
                                job.failed({ operation: OPERATION_DELETE_RULE, step: 'Delete failed' }, (error) => {
                                    if (error) {
                                        console.log(`Operation: ${OPERATION_DELETE_RULE} update failed error \n ${error}`.red)
                                    }
                                })
                            }
                        }
                    })
                    this.jobs.startJobNotifications(this.thing_name, (error) => {
                        if (error) {
                            console.error(error)
                        } else {
                            console.log(`Job notifications initiated for thing: ${this.thing_name}`.green)
                        }
                    })
                    resolve(true)
                })
                this.jobs.on('close', () => {
                    console.log('Jobs has closed'.gray)
                })
                this.jobs.on('reconnect', () => {
                    console.log('Jobs will reconnect'.gray)
                })
                this.jobs.on('offline', () => {
                    console.log('Jobs has offline'.gray)
                })
                this.jobs.on('error', (error) => {
                    console.log('Jobs error: ', error)
                })
                this.jobs.on('message', (topic, payload) => {
                    console.log(`Jobs receive messages: ${topic} ${payload.toString()}`.gray)
                })
            })
        }
        initShadow() {
            return new Promise(resolve => {
                this.thing_shadow = aws_iot.thingShadow({
                    ...this.keys_path,
                    host: config.aws_iot.endpoint,
                    port: config.aws_iot.port,
                    debug: config.aws_iot.debug,
                    clientId: `shadow-${this.thing_name}`
                })
                this.thing_shadow.on('connect', () => {
                    console.log('IoT has connected'.green)
                    this.thing_shadow.register(this.thing_name, (error) => {
                        if (error) {
                            reject(error)
                            console.log('Shadow has unregistered'.red)
                        } else {
                            resolve(true)
                            console.log('Shadow has registered'.green)
                        }
                    })
                    this.thing_shadow.subscribe(`@dovepass/things/${this.thing_name}/info/get`)
                })
                this.thing_shadow.on('message', (topic, message) => {
                    if (topic.match(/^@dovepass\/things\/.*\/info\/get$/)) {
                        let payload = JSON.parse(message.toString())
                        for (let field of (payload.fields || [])) {
                            let method = 'report' + field.replace(/[-_]/g, ' ').replace(/^([a-z])|\s+([a-z])/g, ($1) => {
                                return $1.toUpperCase()
                            }).replace(/\x20/g, '')
                            if (typeof this.$info()[method] === 'function') {
                                this.$info()[method]()
                            }
                        }
                    }
                })
                // this.thing_shadow.on('status', (thing_name, operation, token, payload) => {
                //     console.log(thing_name)
                //     console.log(payload)
                // })
                this.thing_shadow.on('delta', (thing_name, document) => {
                    this.executeDesired(document.state, false)
                })
                this.thing_shadow.on('error', (error) => {
                    console.log('Shadow error'.red, error)
                })
            })
        }
        initCluster() {
            return new Promise(resolve => {
                let connections = []
                fs.readdirSync(STORAGE_PATH).forEach(file => {
                    if (file.match(/^(TCP|RTU)-(.*)\.json/)) {
                        console.log(`Loaded config file[${file}]`.magenta)
                        connections.push(require(`${STORAGE_PATH}/${file}`))
                    }
                })
                try {
                    connections.forEach(config => {
                        let worker = cluster.fork()
                        worker.on('online', () => {
                            this.workerOnlineHandler(worker, config)
                        })
                        worker.on('message', (message) => {
                            this.workerMessageHandler(worker, config, message)
                        })
                        worker.on('disconnect', this.workerDisconnectHandler)
                    })
                } catch (exception) {
                    console.log(exception)
                }
                resolve(true)
            })
        }
        initSchedules() {
            return new Promise(resolve => {
                let schedules = []
                fs.readdirSync(STORAGE_PATH).forEach(file => {
                    if (file.match(/^(Schedule)-(.*)\.json/)) {
                        console.log(`Loaded config file[${file}]`.magenta)
                        schedules.push(require(`${STORAGE_PATH}/${file}`))
                    }
                })
                schedules.forEach((schedule, index) => {
                    this.startSchedule(schedule).then(started => {
                        if ((index + 1) === schedules.length) {
                            this.reportSchedules()
                        }
                    })
                })
                resolve(true)
            })
        }
        initRules() {
            return new Promise(resolve => {
                fs.readdirSync(STORAGE_PATH).forEach(file => {
                    if (file.match(/^(Rule)-(.*)\.json/)) {
                        console.log(`Loaded config file[${file}]`.magenta)
                        let rule = require(`${STORAGE_PATH}/${file}`)
                        this.addRule(rule)
                    }
                })
                this.reportRules()
                resolve(true)
            })
        }
        updateShadowQueue(state) {
            this.update_shadow_queue.push(state)
        }
        processShadowQueue() {
            return new Promise(resolve => {
                setInterval(() => {
                    let state = this.update_shadow_queue.shift()
                    if (state) {
                        let client_token = this.thing_shadow.update(this.thing_name, state)
                        if (client_token === null) {
                            console.log('Update shadow failed, operation still in progress'.red)
                        } else {
                            console.log('Update shadow success: ', `${JSON.stringify(state)}`.cyan)
                        }
                    }
                }, 1000)
                resolve(true)
            })
        }
        processDatasets() {
            return new Promise(resolve => {
                for (let index in cluster.workers) {
                    let worker = cluster.workers[index]
                    this.$timer(worker.name)
                        .shadowReported()
                        .setInterval(() => {
                            let payload = this.$dataset()
                                .shadowReported(worker.name)
                                .get()
                            if (payload) {
                                this.updateShadowQueue({
                                    state: {
                                        reported: payload
                                    }
                                })
                            }
                        }, (parseInt(worker.shadow_report_rate) || 60) * 1000)
                }
                resolve(true)
            })
        }
        processRules() {
            return new Promise(resolve => {
                setInterval(() => {
                    this.executeRules()
                }, 1000)
                resolve(true)
            })
        }
        $info() {
            let that = this
            return {
                reportSerialPort() {
                    SerialPort.list().then(ports => {
                        that.thing_shadow.publish(`@dovepass/things/${that.thing_name}/info/get/accepted`, JSON.stringify({
                            serial_ports: ports.map(port => {
                                return port.comName
                            })
                        }))
                    }, error => {
                        console.log('Can\'t load serial ports', error)
                    })
                }
            }
        }
        $dataset() {
            let that = this
            return {
                shadowReported(name) {
                    return {
                        get() {
                            return that.shadow_datasets[name]
                        },
                        store(dataset) {
                            that.shadow_datasets[name] = dataset
                        },
                        destroy() {
                            delete that.shadow_datasets[name]
                        }
                    }
                },
                collapse() {
                    return {
                        all() {
                            let result = {}
                            for (let name in that.shadow_datasets) {
                                let datasets = that.shadow_datasets[name]
                                result = {
                                    ...result,
                                    ...datasets
                                }
                            }
                            return result
                        }
                    }
                }
            }
        }
        $timer(name) {
            let that = this
            return {
                shadowReported() {
                    let parent = this
                    return {
                        setInterval(callback, interval) {
                            parent.setInterval(`shadow_report-${name}`, callback, interval)
                        },
                        clearInterval() {
                            parent.clearInterval(`shadow_report-${name}`)
                        }
                    }
                },
                setInterval(name, callback, interval) {
                    that.timers[name] = setInterval(callback, interval)
                },
                clearInterval(name) {
                    clearInterval(that.timers[name])
                    delete that.timers[name]
                }
            }
        }
        workerOnlineHandler(worker, config) {
            worker.name = config.name
            worker.shadow_report_rate = config.shadow_report_rate
            worker.send({
                command: 'setConfig',
                data: config
            })
            console.log(`Worker[${worker.name}]{${worker.id}} has registed.`.green)
        }
        workerMessageHandler(worker, config, message) {
            switch (message.command) {
                case 'shadowReported':
                    this.$dataset()
                        .shadowReported(worker.name)
                        .store(message.payload)
                    break
                case 'shadowClearDelta':
                    let desired = {}
                    for (let property in message.payload) {
                        desired[property] = null
                    }
                    this.updateShadowQueue({
                        state: {
                            reported: message.payload || {},
                            desired
                        }
                    })
                    break
                case 'terminated':
                    worker.kill()
                    break
            }
        }
        workerDisconnectHandler() {
            console.log(`Worker[${this.name}]{${this.id}} has unregisted.`.red)
            this.$dataset()
                .shadowReported(this.name)
                .destroy()
            this.$timer(this.name)
                .shadowReported()
                .clearInterval()
        }
        startSchedule(schedule) {
            return new Promise((resolve, reject) => {
                this.schedules[schedule.id] = new CronJob(schedule.expression, () => {
                    this.executeDesired(schedule.actions, true)
                }, null, true, 'UTC')
                console.log(`Schedule [${schedule.name}] started.`.green)
                resolve(true)
            })
        }
        stopSchedule(schedule) {
            return new Promise((resolve, reject) => {
                if (this.schedules[schedule.id]) {
                    this.schedules[schedule.id].stop()
                    delete this.schedules[schedule.id]
                    console.log(`Schedule [${schedule.name}] stoped.`.red)
                }
                resolve(true)
            })
        }
        restartSchedule(schedule) {
            return new Promise((resolve, reject) => {
                this.stopSchedule(schedule).then(stoped => {
                    this.startSchedule(schedule).then(started => {
                        resolve(true)
                    }, error => {
                        reject(false)
                    })
                }, error => {
                    reject(false)
                })
            })
        }
        reportSchedules() {
            this.updateShadowQueue({
                state: {
                    reported: {
                        schedules: Object.keys(this.schedules)
                    }
                }
            })
        }
        addRule(rule) {
            this.rules[rule.id] = rule
        }
        removeRule(rule) {
            delete this.rules[rule.id]
        }
        reportRules() {
            this.updateShadowQueue({
                state: {
                    reported: {
                        rules: Object.keys(this.rules)
                    }
                }
            })
        }
        executeRules() {
            let payload = this.$dataset().collapse().all()
            for (let rule_id in this.rules) {
                let rule = this.rules[rule_id]
                let do_action = false
                let executes = []
                for (let condition of rule.conditions) {
                    let operator = '==='
                    switch (condition.operator) {
                        case '=':
                            operator = '=='
                            break
                        default:
                            operator = condition.operator
                            break
                    }
                    executes.push(`(payload['${condition.property}'] ${operator} ${condition.value})`)
                }
                eval(`do_action = ${executes.join(' && ')}`)
                if (do_action) {
                    let actions = {}
                    for (let action of rule.actions) {
                        actions[action.command] = action.value
                    }
                    this.executeDesired(actions, true)
                } else {
                    // console.log('not thing to do')
                }
            }
        }
        executeDesired(actions, is_local) {
            let state_groups = {}
            let current_worker = null
            for (let property in actions) {
                let name = property.replace(/^([^-]*)-(.*)/, '$1')
                if (!state_groups[name]) {
                    state_groups[name] = {}
                }
                state_groups[name][property] = actions[property]
            }
            for (let name in state_groups) {
                let desired_state = state_groups[name]
                for (let id in cluster.workers) {
                    if (cluster.workers[id].name === name) {
                        current_worker = cluster.workers[id]
                    }
                }
                if (current_worker) {
                    current_worker.send({
                        command: 'shadowDesired',
                        data: desired_state,
                        is_local
                    })
                }
            }
        }
    }
    const modbus_modulator = new ModbusModulator()
    modbus_modulator.initialize()
} else if (cluster.isWorker) {
    let modbus = null
    process.on('message', (message) => {
        switch (message.command) {
            case 'setConfig':
                let config = message.data
                try {
                    if (config.type === 'rtu') {
                        modbus = new ModbusRTU(config)
                    } else if (config.type === 'tcp') {
                        modbus = new ModbusTCP(config)
                    } else {
                        console.log(`Connection Type[${config.type}] not allowed.`.red)
                    }
                } catch (exception) {
                    console.log(exception)
                }
                break
            case 'shadowDesired':
                if (modbus) {
                    modbus.desired(message.data, message.is_local === true)
                } else {
                    console.log(`Modbus connection not ready.`.red)
                }
                break
            case 'terminate':
                modbus.terminate(() => {
                    process.send({
                        command: 'terminated'
                    })
                })
                break
        }
    })
}
