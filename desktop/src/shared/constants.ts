export const APP_DISPLAY_NAME = 'Kinship'
// Storage dir intentionally stays legacy so %APPDATA% does not move; do not change without a migration.
export const APP_STORAGE_DIR_NAME = 'Axeuh Health Desktop'
export const APP_ID = 'com.xehuri.kinship.desktop'

// Default port is 8768; enabling HTTPS keeps the same port (ssl.enabled decides the protocol).
export const DEFAULT_SERVER_URL = 'https://server.example:8768'

export const DEFAULT_SENSOR_PORT = 18888
export const SENSOR_PORT_SCAN_RANGE = Object.freeze({ start: 18889, end: 18898 })
export const DEFAULT_IDLE_THRESHOLD_SECONDS = 300

export const HEALTH_TIMEOUT_MS = 5000
export const SENSOR_START_TIMEOUT_MS = 20000
export const SENSOR_SHUTDOWN_TIMEOUT_MS = 5000

export const DESKTOP_CONFIG_FILENAME = 'desktop-config.json'
export const SENSOR_CONFIG_FILENAME = 'pc-sensor-config.json'
export const LOG_DIRECTORY_NAME = 'logs'
export const LOG_FILENAME = 'desktop.log'
export const LOG_ROTATE_BYTES = 2 * 1024 * 1024
