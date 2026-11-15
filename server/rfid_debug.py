#!/usr/bin/env python3
"""RDM6300 (125 kHz UART) RFID diagnostic.

Usage:
    python3 rfid_debug.py                # 30 s listen
    python3 rfid_debug.py --seconds 60

Wiring (as in Tutorial 2 and the wiring guide):
    reader +5V -> 5 V rail, GND -> GND rail
    reader TX  -> 2.2 kOhm -> [middle] -> 3.3 kOhm -> GND
    middle of the divider -> Pi pin 10 (GPIO15, RXD)
    antenna coil plugged into the reader's 2-pin ANT socket

The reader sends nothing until a 125 kHz card is near the coil. Each read is
0x02, 10 hex characters (tag), 2 hex characters (checksum), 0x03, at 9600 baud.
"""
import argparse
import grp
import os
import time

PORT = "/dev/serial0"
RX_GPIO = 15


def step1_setup(port):
    print("1) Serial port setup")
    real = os.path.realpath(port)
    print(f"   {port} -> {real}")
    if not os.path.exists(real):
        print("   FAIL: port does not exist. Redo the Tutorial 2 serial setup, then reboot.")
        return False
    if real.endswith("ttyS0"):
        print("   WARN: serial0 points to ttyS0, not ttyAMA0: dtoverlay=pi3-disable-bt is not active.")
    groups = {grp.getgrgid(g).gr_name for g in os.getgroups()}
    if os.geteuid() != 0 and "dialout" not in groups:
        print("   FAIL: your user is not in the 'dialout' group: sudo usermod -aG dialout $USER, then log out and back in.")
        return False
    print("   OK")
    return True


def step2_line_level():
    print("2) Voltage on pin 10 (RX line), read as a logic level")
    try:
        import pigpio
    except ImportError:
        print("   skipped: pigpio not installed")
        return
    pi = pigpio.pi()
    if not pi.connected:
        print("   skipped: pigpio service not running (sudo systemctl start pigpiod)")
        return
    samples = [pi.read(RX_GPIO) for _ in range(500)]
    pi.stop()
    high = sum(samples) / len(samples)
    if high > 0.95:
        print("   HIGH (normal idle). Either the reader is powered and its TX reaches the divider,")
        print("   or the pin 10 wire is not connected at all (the Pi pulls an empty RX pin high).")
    elif high < 0.05:
        print("   LOW: fault. The divider's 3.3 kOhm is pulling the line down because no 5 V signal")
        print("   arrives from the reader. Check: reader +5V/GND, TX in the same column as the 2.2 kOhm.")
    else:
        print(f"   CHANGING ({high:.0%} high): data is arriving right now, or the wire is loose.")


def parse(frame):
    """frame = bytes between 0x02 and 0x03. Returns (tag, checksum_ok, card_number) or None."""
    if len(frame) != 12:
        return None
    try:
        text = frame.decode("ascii")
        tag, checksum = text[:10], int(text[10:12], 16)
        calc = 0
        for i in range(0, 10, 2):
            calc ^= int(tag[i:i + 2], 16)
        return tag, calc == checksum, int(tag[2:], 16)
    except ValueError:
        return None


def step3_listen(port, seconds):
    import serial
    print(f"3) Listening on {port} at 9600 baud for {seconds} s. Hold a 125 kHz card flat on the coil.")
    total, good, bad = 0, 0, 0
    tags = set()
    buf = b""
    with serial.Serial(port, 9600, timeout=0.2) as ser:
        ser.reset_input_buffer()
        end = time.time() + seconds
        while time.time() < end:
            chunk = ser.read(64)
            if not chunk:
                continue
            total += len(chunk)
            print(f"   raw: {chunk.hex(' ')}")
            buf += chunk
            while b"\x02" in buf:
                start = buf.index(b"\x02")
                stop = buf.find(b"\x03", start)
                if stop == -1:
                    buf = buf[start:]
                    break
                result = parse(buf[start + 1:stop])
                buf = buf[stop + 1:]
                if result and result[1]:
                    good += 1
                    tags.add(result[0])
                    print(f"   CARD {result[0]}  (number printed on many cards: {result[2]:010d})  checksum OK")
                else:
                    bad += 1
                    print("   frame received but malformed or wrong checksum")
            if len(buf) > 200:
                buf = buf[-50:]

    print("\nResult")
    print(f"   bytes received: {total}, good reads: {good}, bad frames: {bad}, different cards: {len(tags)}")
    if total == 0:
        print("   NOTHING RECEIVED. Most likely, in order:")
        print("   - the card is not 125 kHz: the blue key fobs and white cards from RC522 kits are 13.56 MHz and never work here")
        print("   - the antenna coil is not plugged into the ANT socket")
        print("   - the reader has no 5 V (check its +5V and GND pins against the rails)")
        print("   - TX does not reach pin 10 (step 2 says LOW, or a wire is in the wrong column)")
    elif good == 0:
        print("   DATA BUT NO VALID CARD: the signal arrives garbled.")
        print("   - check both resistor values (2.2 kOhm red-red-red, 3.3 kOhm orange-orange-red) and that pin 10 is on the middle column")
        print("   - push all jumpers in firmly: a loose TX wire gives random bytes")
    else:
        print("   WORKING. Write these card IDs down for the users collection:")
        for t in sorted(tags):
            print(f"   - {t}")


def main():
    parser = argparse.ArgumentParser(description="RDM6300 RFID diagnostic")
    parser.add_argument("--seconds", type=int, default=30)
    parser.add_argument("--port", default=PORT)
    args = parser.parse_args()
    if step1_setup(args.port):
        step2_line_level()
        step3_listen(args.port, args.seconds)


if __name__ == "__main__":
    main()
