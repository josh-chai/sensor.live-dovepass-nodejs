'strict'

if (!Array.prototype.asyncForEach) {
    Array.prototype.asyncForEach = async function(callback) {
        for (let index = 0; index < this.length; index++) {
            await callback(this[index], index, this)
        }
    }
}

module.exports = Array.prototype.asyncForEach
