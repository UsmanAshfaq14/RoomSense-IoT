#!/usr/bin/env python3
"""RoomSense room node: runs on the Raspberry Pi.

Reads the sensors, publishes them over MQTT, and drives the LEDs and fan from the
server's commands. The Pi only talks to the MQTT broker: no database, no HTTP,
no room logic. Every decision is taken by the server.

Usage:
    python3 roomsense_node.py --broker 10.12.72.4
    python3 roomsense_node.py --broker 10.12.72.4 --room ME407 --debug

Topics (base = campus/<room>):
    publishes  sensor/presence     {"ts", "presence"}                          on change
               sensor/climate      {"ts", "celsius", "humidity", "hPa", "gasOhms"}  on change or every 5 min
               sensor/light        {"ts", "lux", "saturated"}                  on change or every 5 min
               sensor/rfid         {"ts", "uid"}                               each badge (QoS 1)
               node/status         "online" / "offline" (retained, offline = Last Will)
               actuator/<name>/state   echo of each command once applied
    subscribes actuator/status/set   {"state": "free" | "reserved" | "occupied" | "offline"}
               actuator/heating/set  {"on": true|false}
               actuator/light/set    {"on": true|false, "level": 0..1}
               actuator/fan/set      {"on": true|false, "speed": 0..1}
               rfid/result           {"granted": true|false, "reason": "..."}
"""
import argparse
import json
import logging
import os
import signal
import threading
import time

import paho.mqtt.client as mqtt

# ---------- settings ----------
DEFAULT_BROKER = "10.12.72.4"   # laptop IP on the university network; check with ipconfig each morning
DEFAULT_ROOM = "ME407"

PIN_PIR = 17          # physical 11
PIN_FAN = 18          # physical 12 (FS90R signal)
PIN_STATUS_LED = 27   # physical 13
PIN_HEAT_LED = 22     # physical 15
PIN_ROOM_LED = 13     # physical 33
SERIAL_PORT = "/dev/serial0"

CLIMATE_PERIOD_S = 5        # how often the BME680 is read
LIGHT_PERIOD_S = 2          # how often the light sensor is read
HEARTBEAT_S = 300           # publish at least this often even without change
TEMP_DELTA_C = 0.2          # publish when temperature moves this much
HUMIDITY_DELTA = 1.0        # ... or humidity (percentage points)
GAS_DELTA_RATIO = 0.10      # ... or gas resistance (10 %)
LUX_DELTA_RATIO = 0.15      # publish when light changes by 15 % ...
LUX_DELTA_MIN = 5.0         # ... and by at least 5 lux
RFID_DEBOUNCE_S = 3.0       # the reader repeats a held card about once a second
FAN_DIRECTION = 1           # set to -1 if the fan spins the wrong way
TSL2591_MAX_LUX = 88000.0   # reported when the sensor saturates

log = logging.getLogger("roomsense")


def now():
    return round(time.time(), 3)


def changed(new, old, abs_delta=0.0, ratio=0.0):
    if old is None:
        return True
    diff = abs(new - old)
    if ratio:
        return diff >= max(abs_delta, abs(old) * ratio)
    return diff >= abs_delta


class Node:
    def __init__(self, broker, port, room):
        self.broker, self.port, self.room = broker, port, room
        self.base = f"campus/{room}"
        self.stop = threading.Event()
        self.force_publish = threading.Event()   # set on (re)connect: send fresh values at once
        self.status_state = "free"
        self.status_lock = threading.Lock()

        self.client = mqtt.Client(mqtt.CallbackAPIVersion.VERSION2, client_id=f"node-{room}")
        self.client.will_set(f"{self.base}/node/status", "offline", qos=1, retain=True)
        self.client.on_connect = self.on_connect
        self.client.on_disconnect = self.on_disconnect
        self.client.on_message = self.on_message
        self.client.reconnect_delay_set(min_delay=1, max_delay=30)

        self.setup_gpio()

    # ---------- MQTT ----------
    def publish(self, sub, payload, qos=0, retain=False):
        data = payload if isinstance(payload, str) else json.dumps(payload)
        self.client.publish(f"{self.base}/{sub}", data, qos=qos, retain=retain)
        log.debug("-> %s %s", sub, data)

    def on_connect(self, client, userdata, flags, reason_code, properties):
        if reason_code.is_failure:
            log.error("broker refused the connection: %s", reason_code)
            return
        log.info("connected to %s:%s as node-%s", self.broker, self.port, self.room)
        client.subscribe([(f"{self.base}/actuator/+/set", 1), (f"{self.base}/rfid/result", 1)])
        self.publish("node/status", "online", qos=1, retain=True)
        if self.pir is not None:
            self.publish("sensor/presence", {"ts": now(), "presence": bool(self.pir.motion_detected)})
        self.force_publish.set()

    def on_disconnect(self, client, userdata, flags, reason_code, properties):
        if not self.stop.is_set():
            log.warning("lost the broker (%s); reconnecting automatically", reason_code)

    def on_message(self, client, userdata, msg):
        try:
            data = json.loads(msg.payload.decode() or "{}")
            if not isinstance(data, dict):
                raise ValueError("payload is not a JSON object")
        except (ValueError, UnicodeDecodeError) as err:
            log.warning("ignored bad payload on %s: %s", msg.topic, err)
            return
        sub = msg.topic[len(self.base) + 1:]
        handlers = {
            "actuator/status/set": self.cmd_status,
            "actuator/heating/set": self.cmd_heating,
            "actuator/light/set": self.cmd_light,
            "actuator/fan/set": self.cmd_fan,
            "rfid/result": self.cmd_rfid_result,
        }
        handler = handlers.get(sub)
        if handler is None:
            log.warning("no handler for %s", msg.topic)
            return
        try:
            handler(data)
        except Exception as err:  # a bad command must never stop the node
            log.exception("command on %s failed: %s", msg.topic, err)

    # ---------- GPIO ----------
    def setup_gpio(self):
        from gpiozero import LED, PWMLED, MotionSensor, Servo, Device
        if "GPIOZERO_PIN_FACTORY" not in os.environ:
            try:
                from gpiozero.pins.pigpio import PiGPIOFactory
                Device.pin_factory = PiGPIOFactory()
                log.info("GPIO: hardware-timed PWM via pigpio")
            except Exception:
                log.warning("GPIO: pigpio not running, software PWM (fan may jitter): sudo systemctl enable --now pigpiod")
        self.status_led = LED(PIN_STATUS_LED)
        self.heat_led = LED(PIN_HEAT_LED)
        self.room_led = PWMLED(PIN_ROOM_LED)
        self.fan = Servo(PIN_FAN, min_pulse_width=0.001, max_pulse_width=0.002)
        self.fan.detach()   # no pulses = fully stopped
        try:
            self.pir = MotionSensor(PIN_PIR)
            self.pir.when_motion = lambda: self.publish("sensor/presence", {"ts": now(), "presence": True})
            self.pir.when_no_motion = lambda: self.publish("sensor/presence", {"ts": now(), "presence": False})
        except Exception as err:
            log.error("PIR disabled: %s", err)
            self.pir = None

    def apply_status(self):
        state = self.status_state
        if state == "occupied":
            self.status_led.on()
        elif state == "reserved":
            self.status_led.blink(on_time=0.5, off_time=0.5)
        else:  # free or offline
            self.status_led.off()

    def cmd_status(self, data):
        state = data.get("state")
        if state not in ("free", "reserved", "occupied", "offline"):
            raise ValueError(f"unknown state {state!r}")
        with self.status_lock:
            self.status_state = state
            self.apply_status()
        self.publish("actuator/status/state", {"ts": now(), "state": state}, qos=1)

    def cmd_rfid_result(self, data):
        granted = bool(data.get("granted"))

        def flash():
            with self.status_lock:
                if granted:
                    self.status_led.blink(on_time=0.15, off_time=0.15, n=2, background=False)
                else:
                    self.status_led.blink(on_time=0.06, off_time=0.06, n=6, background=False)
                self.apply_status()
        threading.Thread(target=flash, daemon=True).start()
        log.info("badge %s: %s", "granted" if granted else "denied", data.get("reason", ""))

    def cmd_heating(self, data):
        on = bool(data.get("on"))
        self.heat_led.value = 1 if on else 0
        self.publish("actuator/heating/state", {"ts": now(), "on": on}, qos=1)

    def cmd_light(self, data):
        on = bool(data.get("on"))
        level = min(max(float(data.get("level", 1.0)), 0.0), 1.0)
        self.room_led.value = level if on else 0
        self.publish("actuator/light/state", {"ts": now(), "on": on, "level": level if on else 0}, qos=1)

    def cmd_fan(self, data):
        on = bool(data.get("on"))
        speed = min(max(float(data.get("speed", 0.9)), 0.0), 1.0)
        if on and speed > 0:
            self.fan.value = FAN_DIRECTION * speed
        else:
            self.fan.detach()
        self.publish("actuator/fan/state", {"ts": now(), "on": on and speed > 0, "speed": speed if on else 0}, qos=1)

    # ---------- sensor loops ----------
    def climate_loop(self):
        try:
            import bme680
            try:
                sensor = bme680.BME680(bme680.I2C_ADDR_PRIMARY)
            except (RuntimeError, IOError):
                sensor = bme680.BME680(bme680.I2C_ADDR_SECONDARY)
            sensor.set_humidity_oversample(bme680.OS_2X)
            sensor.set_pressure_oversample(bme680.OS_4X)
            sensor.set_temperature_oversample(bme680.OS_8X)
            sensor.set_filter(bme680.FILTER_SIZE_3)
            sensor.set_gas_status(bme680.ENABLE_GAS_MEAS)
            sensor.set_gas_heater_temperature(320)
            sensor.set_gas_heater_duration(150)
            sensor.select_gas_heater_profile(0)
        except Exception as err:
            log.error("BME680 disabled: %s", err)
            return
        last, last_sent = {}, 0.0
        while not self.stop.is_set():
            try:
                if sensor.get_sensor_data():
                    d = sensor.data
                    gas = round(d.gas_resistance) if d.heat_stable else None
                    reading = {"celsius": round(d.temperature, 2), "humidity": round(d.humidity, 1),
                               "hPa": round(d.pressure, 1), "gasOhms": gas}
                    due = (self.force_publish.is_set() or time.time() - last_sent >= HEARTBEAT_S
                           or changed(reading["celsius"], last.get("celsius"), TEMP_DELTA_C)
                           or changed(reading["humidity"], last.get("humidity"), HUMIDITY_DELTA)
                           or (gas is not None and changed(gas, last.get("gasOhms"), ratio=GAS_DELTA_RATIO)))
                    if due:
                        self.publish("sensor/climate", {"ts": now(), **reading})
                        last, last_sent = reading, time.time()
                        self.force_publish.clear()
            except Exception as err:
                log.warning("BME680 read failed: %s", err)
            self.stop.wait(CLIMATE_PERIOD_S)

    def open_light_sensor(self):
        import board
        i2c = board.I2C()
        errors = []
        try:
            import adafruit_tsl2591
            sensor = adafruit_tsl2591.TSL2591(i2c)
            sensor.gain = adafruit_tsl2591.GAIN_LOW   # medium gain overflows above ~4,000 lux
            return sensor, "TSL2591"
        except Exception as err:
            errors.append(f"TSL2591: {err} (adafruit_tsl2591.py must sit next to this script)")
        try:
            import adafruit_veml7700
            return adafruit_veml7700.VEML7700(i2c), "VEML7700"
        except Exception as err:
            errors.append(f"VEML7700: {err}")
        raise RuntimeError("; ".join(errors))

    def light_loop(self):
        try:
            sensor, name = self.open_light_sensor()
            log.info("light sensor: %s", name)
        except Exception as err:
            log.error("light sensor disabled: %s", err)
            return
        last, last_sent = None, 0.0
        while not self.stop.is_set():
            saturated = False
            try:
                lux = float(sensor.lux)
            except RuntimeError:
                lux, saturated = TSL2591_MAX_LUX, True
            except Exception as err:
                log.warning("light read failed: %s", err)
                self.stop.wait(LIGHT_PERIOD_S)
                continue
            due = (self.force_publish.is_set() or time.time() - last_sent >= HEARTBEAT_S
                   or changed(lux, last, LUX_DELTA_MIN, LUX_DELTA_RATIO))
            if due:
                self.publish("sensor/light", {"ts": now(), "lux": round(lux, 1), "saturated": saturated})
                last, last_sent = lux, time.time()
            self.stop.wait(LIGHT_PERIOD_S)

    @staticmethod
    def parse_rdm6300(frame):
        text = frame.decode("ascii")
        tag, checksum = text[:10], int(text[10:12], 16)
        calc = 0
        for i in range(0, 10, 2):
            calc ^= int(tag[i:i + 2], 16)
        return tag if calc == checksum else None

    def rfid_loop(self):
        try:
            import serial
            port = serial.Serial(SERIAL_PORT, 9600, timeout=0.5)
        except Exception as err:
            log.error("RFID disabled: %s", err)
            return
        last_tag, last_time = None, 0.0
        with port:
            while not self.stop.is_set():
                try:
                    if port.read(1) != b"\x02":
                        continue
                    frame = port.read(12)
                    if len(frame) != 12 or port.read(1) != b"\x03":
                        continue
                    tag = self.parse_rdm6300(frame)
                except Exception as err:
                    log.warning("RFID read failed: %s", err)
                    continue
                if tag is None:
                    continue
                if tag == last_tag and time.time() - last_time < RFID_DEBOUNCE_S:
                    last_time = time.time()   # card still held: ignore the repeat
                    continue
                last_tag, last_time = tag, time.time()
                log.info("badge %s", tag)
                self.publish("sensor/rfid", {"ts": now(), "uid": tag}, qos=1)

    # ---------- run ----------
    def run(self):
        for loop in (self.climate_loop, self.light_loop, self.rfid_loop):
            threading.Thread(target=loop, daemon=True, name=loop.__name__).start()
        self.client.connect_async(self.broker, self.port, keepalive=10)
        self.client.loop_start()
        log.info("RoomSense node for %s started; broker %s:%s. Ctrl+C to stop.", self.room, self.broker, self.port)
        self.stop.wait()

    def shutdown(self, *_):
        if self.stop.is_set():
            return
        log.info("stopping")
        self.stop.set()
        try:
            self.publish("node/status", "offline", qos=1, retain=True)
            time.sleep(0.3)
            self.client.disconnect()
            self.client.loop_stop()
        finally:
            self.fan.detach()
            for dev in (self.status_led, self.heat_led, self.room_led, self.fan, self.pir):
                if dev is not None:
                    dev.close()


def main():
    parser = argparse.ArgumentParser(description="RoomSense room node")
    parser.add_argument("--broker", default=DEFAULT_BROKER)
    parser.add_argument("--port", type=int, default=1883)
    parser.add_argument("--room", default=DEFAULT_ROOM)
    parser.add_argument("--debug", action="store_true", help="log every message sent")
    args = parser.parse_args()
    logging.basicConfig(level=logging.DEBUG if args.debug else logging.INFO,
                        format="%(asctime)s %(levelname)s %(message)s", datefmt="%H:%M:%S")
    node = Node(args.broker, args.port, args.room)
    signal.signal(signal.SIGINT, node.shutdown)
    signal.signal(signal.SIGTERM, node.shutdown)
    node.run()


if __name__ == "__main__":
    main()
