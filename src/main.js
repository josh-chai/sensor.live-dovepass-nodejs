'strict'

const cluster = require('cluster')
const { Master, Worker } = require('./Modulator')

if (cluster.isMaster) {
    (new Master()).initialize()
} else if (cluster.isWorker) {
    (new Worker()).initialize()
}
