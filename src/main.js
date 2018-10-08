'strict'

const cluster = require('cluster')
const { Master, Worker } = require('./Modulator')
const ThingRegistry = require('sensor.live-things-registry')

if (cluster.isMaster) {
    const test_thing_name = 'RP1'
    const thing_name = test_thing_name
    const thing_registry = new ThingRegistry()
    thing_registry.setCertsPath('./certs')
    if (!thing_registry.hasDeviceCertificate()) {
        thing_registry.generateDeviceCertificate({
            thing_name
        })
    }
    const keys_path = thing_registry.getKeysPath()
    const endpoint = 'axt811sti1q4w.iot.ap-northeast-1.amazonaws.com'
    const port = 8883
    const enable_log = true
    const enable_debug = false
    const master = (new Master({
        thing_name,
        keys_path,
        endpoint,
        port,
        enable_log,
        enable_debug
    })).run()
} else if (cluster.isWorker) {
    const worker = (new Worker()).run()
}
