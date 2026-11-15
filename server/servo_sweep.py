#!/usr/bin/env python3
"""FS90R direction check: sweep the pulse width and watch which way the servo turns.

Usage:
    python3 servo_sweep.py          # full sweep, 700 to 2300 microseconds
    python3 servo_sweep.py 1300     # hold one pulse width for 4 s

Needs the pigpio service: sudo systemctl enable --now pigpiod
Signal on GPIO18 (physical pin 12).
"""
import sys
import time

import pigpio

PIN = 18
STEPS = [700, 900, 1100, 1300, 1400, 1450, 1500, 1550, 1600, 1700, 1900, 2100, 2300]
HOLD = 2.5  # seconds per step

pi = pigpio.pi()
if not pi.connected:
    sys.exit("pigpio service not running: sudo systemctl enable --now pigpiod")


def stop():
    pi.set_servo_pulsewidth(PIN, 0)  # 0 = no pulses = completely still


try:
    if len(sys.argv) > 1:
        us = int(sys.argv[1])
        if not 500 <= us <= 2500:
            sys.exit("use a value between 500 and 2500")
        print(f"{us} us for 4 s")
        pi.set_servo_pulsewidth(PIN, us)
        time.sleep(4)
    else:
        print("Watch the servo and note what it does at each step:")
        print("  CW = clockwise, CCW = counter-clockwise, STOP = still\n")
        for us in STEPS:
            print(f"  {us:4d} us ...", flush=True)
            pi.set_servo_pulsewidth(PIN, us)
            time.sleep(HOLD)
        print("\nExpected for an FS90R: one direction below ~1500, still near 1500, the other direction above.")
        print("If it turns the same way everywhere, check that orange is on pin 12 and brown on GND.")
finally:
    stop()
    pi.stop()
    print("Stopped.")
