#!/usr/bin/env python3
"""RoomSense hardware check: test each sensor and actuator on its own.

Usage:
    python3 check_hardware.py <test> [--broker IP]

Tests:
    i2c     scan the I2C bus (BME680 at 0x76, VEML7700 at 0x10, TSL2591 at 0x29)
    bme680  read temperature, humidity, pressure, gas for 20 s
    light   read lux from the VEML7700 (or TSL2591) while you cover it
    pir     wait for motion, then for it to clear
    rfid    read one badge from the RDM6300 UART reader
    leds    blink status, heating and room-lights LEDs
    servo   FS90R continuous servo: spin one way, stop, spin back, stop
    mqtt    publish/subscribe round trip through a broker (needs --broker)
    all     run every test above in turn and print a summary

Install once (after Blinka, using the Adafruit guide from the course):
    sudo apt install -y python3-serial i2c-tools pigpio python3-pigpio
    sudo systemctl enable --now pigpiod
    pip3 install bme680                          # BME680 driver (Pimoroni guide)
    pip3 install adafruit-circuitpython-tsl2591  # only if your light sensor is a TSL2591

Pin numbers are BCM GPIO numbers (physical header pin in brackets).
They match the RoomSense wiring guide.
"""
import argparse
import subprocess
import sys
import time

PIN_PIR = 17          # physical pin 11
PIN_SERVO = 18        # physical pin 12
PIN_STATUS_LED = 27   # physical pin 13
PIN_HEAT_LED = 22     # physical pin 15
PIN_ROOM_LED = 13     # physical pin 33
SERIAL_PORT = "/dev/ttyAMA0"   # RDM6300 TX -> divider -> pin 10 (GPIO15 RXD), as in Tutorial 2

KNOWN_I2C = {
    0x76: "BME680 (Pimoroni default)",
    0x77: "BME680 (alternate address)",
    0x10: "VEML7700 light sensor",
    0x29: "TSL2591 light sensor",
}


def result(name, ok, detail=""):
    print(f"\n[{'PASS' if ok else 'FAIL'}] {name}" + (f": {detail}" if detail else ""))
    return ok


def ask(question):
    return input(f"{question} [y/n] ").strip().lower().startswith("y")


def test_i2c(args):
    import board  # Blinka, already installed for the Adafruit light sensor
    i2c = board.I2C()
    while not i2c.try_lock():
        time.sleep(0.01)
    try:
        found = i2c.scan()
    finally:
        i2c.unlock()
    for addr in found:
        print(f"  0x{addr:02x}  {KNOWN_I2C.get(addr, 'unknown device')}")
    has_bme = 0x76 in found or 0x77 in found
    has_light = 0x10 in found or 0x29 in found
    problems = []
    if not has_bme:
        problems.append("no BME680")
    if not has_light:
        problems.append("no light sensor")
    detail = f"{len(found)} device(s) found"
    if problems:
        detail += "; " + ", ".join(problems) + ": check SDA (pin 3), SCL (pin 5), the bus jumpers and the 3.3 V rail"
    return result("I2C bus", has_bme and has_light, detail)


def test_bme680(args):
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

    print("Reading for 20 s. Breathe on the sensor: humidity should jump.")
    temps = []
    end = time.time() + 20
    while time.time() < end:
        if sensor.get_sensor_data():
            d = sensor.data
            gas = f"{d.gas_resistance:.0f} ohm" if d.heat_stable else "heater warming up"
            print(f"  {d.temperature:5.1f} C  {d.humidity:5.1f} %RH  {d.pressure:7.1f} hPa  gas {gas}")
            temps.append(d.temperature)
        time.sleep(1)
    ok = bool(temps) and all(-10 < t < 60 for t in temps)
    return result("BME680", ok, f"{len(temps)} readings" if ok else "no plausible readings")


def open_light_sensor():
    import board
    i2c = board.I2C()
    errors = []
    try:
        import adafruit_veml7700
        return adafruit_veml7700.VEML7700(i2c), "VEML7700"
    except Exception as err:  # library missing or sensor not on the bus
        errors.append(f"VEML7700: {err}")
    try:
        import adafruit_tsl2591
        return adafruit_tsl2591.TSL2591(i2c), "TSL2591"
    except Exception as err:
        errors.append(f"TSL2591: {err}")
    raise RuntimeError("; ".join(errors))


def test_light(args):
    try:
        sensor, name = open_light_sensor()
    except RuntimeError as err:
        return result("Light sensor", False, f"not found ({err})")
    print(f"{name} found. Cover the sensor with your hand, then uncover it, during the next 15 s...")
    readings = []
    end = time.time() + 15
    while time.time() < end:
        lux = sensor.lux
        readings.append(lux)
        print(f"  {lux:8.1f} lux")
        time.sleep(0.5)
    lo, hi = min(readings), max(readings)
    ok = hi > 0 and lo < hi * 0.5
    return result(f"Light sensor ({name})", ok,
                  f"{lo:.1f} to {hi:.1f} lux" if ok
                  else "readings barely changed: cover the sensor fully, check SDA/SCL bus jumpers")


def test_pir(args):
    from gpiozero import MotionSensor
    pir = MotionSensor(PIN_PIR)
    print("The PIR needs 30-60 s after power-up to settle.")
    print("Wave in front of it within 30 s...")
    detected = pir.wait_for_motion(timeout=30)
    cleared = False
    if detected:
        print("  motion detected. Now keep still or step out of view (up to 60 s)...")
        cleared = pir.wait_for_no_motion(timeout=60)
        print("  motion cleared" if cleared else "  still reporting motion")
    pir.close()
    if not detected:
        return result("PIR", False, "no motion seen: check OUT on pin 11, VCC on the 5 V rail, wait for warm-up")
    return result("PIR", cleared, "detects and clears" if cleared
                  else "never clears: turn the time-delay knob to minimum")


def parse_rdm6300(frame):
    """frame = the 12 ASCII characters between 0x02 and 0x03: 10 for the tag, 2 for the checksum."""
    text = frame.decode("ascii")
    tag, checksum = text[:10], int(text[10:12], 16)
    calc = 0
    for i in range(0, 10, 2):
        calc ^= int(tag[i:i + 2], 16)
    return tag, calc == checksum


def test_rfid(args):
    import serial
    try:
        port = serial.Serial(SERIAL_PORT, 9600, timeout=0.5)
    except serial.SerialException as err:
        return result("RFID RDM6300", False, f"cannot open {SERIAL_PORT} ({err}): redo the serial setup from Tutorial 2")
    print("Hold a 125 kHz badge on the antenna coil within 20 s...")
    tag, valid = None, False
    end = time.time() + 20
    try:
        while tag is None and time.time() < end:
            if port.read(1) != b"\x02":
                continue
            frame = port.read(12)
            if len(frame) == 12 and port.read(1) == b"\x03":
                try:
                    tag, valid = parse_rdm6300(frame)
                except ValueError:
                    print("  garbled frame, keep holding the badge")
    finally:
        port.close()
    if tag is None:
        return result("RFID RDM6300", False,
                      "no badge read: check +5V/GND, the antenna plug, TX -> divider -> pin 10, and the serial setup")
    return result("RFID RDM6300", valid, f"badge {tag}" + ("" if valid else " (checksum wrong: check the divider)"))


def test_leds(args):
    from gpiozero import LED, PWMLED
    status, heat, room = LED(PIN_STATUS_LED), LED(PIN_HEAT_LED), PWMLED(PIN_ROOM_LED)
    print("Status LED (pin 13, green) blinks 3 times...")
    status.blink(on_time=0.3, off_time=0.3, n=3, background=False)
    print("Heating LED (pin 15, red) blinks 3 times...")
    heat.blink(on_time=0.3, off_time=0.3, n=3, background=False)
    print("Room-lights LED (pin 33, yellow) fades up and down...")
    steps = [i / 20 for i in range(21)]
    for value in steps + steps[::-1]:
        room.value = value
        time.sleep(0.05)
    for led in (status, heat, room):
        led.close()
    ok = ask("Did all three LEDs do their part?")
    return result("LEDs", ok, "" if ok
                  else "check LED direction (long leg towards the resistor), the resistor columns, and GND")


def test_servo(args):
    from gpiozero import Servo
    factory = None
    try:
        from gpiozero.pins.pigpio import PiGPIOFactory
        factory = PiGPIOFactory()
    except Exception:
        print("  pigpio daemon not reachable (sudo systemctl start pigpiod): software PWM, the stop may creep.")
    # FS90R: 1.5 ms pulse = stop, shorter/longer = spin one way/the other.
    servo = Servo(PIN_SERVO, min_pulse_width=0.001, max_pulse_width=0.002, pin_factory=factory)
    for label, value, seconds in [("stop", 0.0, 1), ("spin one way", 0.6, 2), ("stop", 0.0, 1),
                                  ("spin the other way", -0.6, 2), ("stop", 0.0, 1)]:
        print(f"  {label}")
        servo.value = value
        time.sleep(seconds)
    servo.detach()
    servo.close()
    ok = ask("Did it spin both ways and stop in between?")
    return result("FS90R servo", ok, "" if ok
                  else "check orange on pin 12, red on the 5 V rail, brown on GND; if it creeps at 'stop', trim the stop value")


def test_mqtt(args):
    import paho.mqtt.client as mqtt
    if not args.broker:
        return result("MQTT", False, "give the broker's IP address: --broker 192.168.x.x")
    topic, received = "roomsense/selftest", []

    def on_connect(client, userdata, flags, reason_code, properties):
        client.subscribe(topic, qos=1)

    def on_message(client, userdata, message):
        received.append(message.payload.decode())

    client = mqtt.Client(mqtt.CallbackAPIVersion.VERSION2)
    client.on_connect = on_connect
    client.on_message = on_message
    try:
        client.connect(args.broker, 1883, 60)
    except OSError as err:
        return result("MQTT", False, f"cannot reach {args.broker}:1883 ({err})")
    client.loop_start()
    time.sleep(1)
    client.publish(topic, "ping", qos=1)
    end = time.time() + 5
    while not received and time.time() < end:
        time.sleep(0.1)
    client.loop_stop()
    client.disconnect()
    return result("MQTT", "ping" in received, "round trip OK" if received
                  else "connected but no message came back")


TESTS = {
    "i2c": test_i2c, "bme680": test_bme680, "light": test_light, "pir": test_pir,
    "rfid": test_rfid, "leds": test_leds, "servo": test_servo, "mqtt": test_mqtt,
}


def run_all(args):
    order = ["i2c", "bme680", "light", "pir", "rfid", "leds", "servo"]
    if args.broker:
        order.append("mqtt")
    summary = {}
    for name in order:
        print(f"\n=========== {name} ===========")
        cmd = [sys.executable, __file__, name]
        if args.broker:
            cmd += ["--broker", args.broker]
        # Each test runs in its own process so a crash or a held GPIO pin
        # in one test cannot affect the next.
        summary[name] = subprocess.run(cmd).returncode == 0
    print("\n=========== summary ===========")
    for name, ok in summary.items():
        print(f"  {'PASS' if ok else 'FAIL'}  {name}")
    return all(summary.values())


def main():
    parser = argparse.ArgumentParser(description="RoomSense hardware check")
    parser.add_argument("test", nargs="?", default="all", choices=list(TESTS) + ["all"],
                        help="which test to run (default: all)")
    parser.add_argument("--broker", help="broker IP address for the mqtt test")
    args = parser.parse_args()
    if args.test == "all":
        ok = run_all(args)
    else:
        try:
            ok = TESTS[args.test](args)
        except ModuleNotFoundError as err:
            hints = {"gpiozero": "sudo apt install python3-gpiozero", "serial": "sudo apt install python3-serial",
                     "board": "install Blinka with the Adafruit guide", "bme680": "pip3 install bme680",
                     "paho": "pip3 install paho-mqtt",
                     "adafruit_veml7700": "pip3 install adafruit-circuitpython-veml7700",
                     "adafruit_tsl2591": "pip3 install adafruit-circuitpython-tsl2591"}
            ok = result(args.test, False, f"missing library '{err.name}': {hints.get(err.name, 'install it with pip3')}")
    sys.exit(0 if ok else 1)


if __name__ == "__main__":
    main()
