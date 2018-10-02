module.exports = {
    getTemperature(hex_value) {
        return parseFloat((((hex_value * 16 / 65535) + 4 - 4) / 0.32).toFixed(2))
    },
    getHumidity(hex_value) {
        return parseFloat((((hex_value * 16 / 65535) + 4 - 4) * 6.25).toFixed(2))
    },
    getSensitive(value) {
        return (value - 500) * 100 / (3500 - 500)
    }
}
