"""
Archive Button - ESP32 firmware (MicroPython).

Hardware
  Push button : GPIO 4 -> GND   (internal pull-up used)
  Buzzer      : GPIO 5 (+) -> GND (passive buzzer, driven by PWM)

Files to copy onto the board (e.g. with Thonny or mpremote)
  main.py (this file), secrets.py, certs/ca.pem, certs/device.pem.crt, certs/private.pem.key

secrets.py example
  WIFI_SSID = "..."
  WIFI_PASSWORD = "..."
  IOT_ENDPOINT = "xxxxxxxx-ats.iot.eu-west-1.amazonaws.com"
  DEVICE_ID = "archive-button-01"

Behaviour
  Hold button 2 s -> publish to archive-button/<id>/press
  Result message  -> 1 short beep (success), 2 beeps (partial), 1 long tone (failed)
  Heartbeat every 60 s on archive-button/<id>/heartbeat (used for offline detection)
"""
import json
import time
import network
import machine
from machine import Pin, PWM
from umqtt.simple import MQTTClient
import secrets

BUTTON_PIN = 4
BUZZER_PIN = 5
HOLD_MS = 2000
HEARTBEAT_S = 60

DEVICE_ID = secrets.DEVICE_ID
TOPIC_PRESS = "archive-button/%s/press" % DEVICE_ID
TOPIC_RESULT = "archive-button/%s/result" % DEVICE_ID
TOPIC_HEARTBEAT = "archive-button/%s/heartbeat" % DEVICE_ID

button = Pin(BUTTON_PIN, Pin.IN, Pin.PULL_UP)
buzzer = PWM(Pin(BUZZER_PIN), freq=880, duty=0)


def tone(ms, freq=880):
    buzzer.freq(freq)
    buzzer.duty(512)
    time.sleep_ms(ms)
    buzzer.duty(0)


def play(status):
    if status == "success":
        tone(150)
    elif status == "partial":
        tone(150)
        time.sleep_ms(120)
        tone(150)
    else:
        tone(1200, 220)


def wifi_connect():
    wlan = network.WLAN(network.STA_IF)
    wlan.active(True)
    if not wlan.isconnected():
        wlan.connect(secrets.WIFI_SSID, secrets.WIFI_PASSWORD)
        for _ in range(40):
            if wlan.isconnected():
                break
            time.sleep(0.5)
    if not wlan.isconnected():
        raise OSError("Wi-Fi connection failed")


def read_file(path):
    with open(path, "rb") as f:
        return f.read()


def on_message(topic, msg):
    try:
        status = json.loads(msg).get("status", "failed")
    except ValueError:
        status = "failed"
    play(status)


def mqtt_connect():
    ssl_params = {
        "key": read_file("certs/private.pem.key"),
        "cert": read_file("certs/device.pem.crt"),
        "server_hostname": secrets.IOT_ENDPOINT,
    }
    client = MQTTClient(DEVICE_ID, secrets.IOT_ENDPOINT, port=8883,
                        keepalive=60, ssl=True, ssl_params=ssl_params)
    client.set_callback(on_message)
    client.connect()
    client.subscribe(TOPIC_RESULT, qos=1)
    return client


def button_held():
    """True once the button has been held continuously for HOLD_MS."""
    if button.value() != 0:
        return False
    start = time.ticks_ms()
    while button.value() == 0:
        if time.ticks_diff(time.ticks_ms(), start) >= HOLD_MS:
            tone(60, 1200)          # "accepted" tick
            while button.value() == 0:   # wait for release so one hold = one run
                time.sleep_ms(20)
            return True
        time.sleep_ms(20)
    return False


def main():
    wifi_connect()
    client = mqtt_connect()
    last_beat = 0
    while True:
        try:
            client.check_msg()
            now = time.time()
            if now - last_beat >= HEARTBEAT_S:
                client.publish(TOPIC_HEARTBEAT, json.dumps({"deviceId": DEVICE_ID, "t": now}))
                last_beat = now
            if button_held():
                client.publish(TOPIC_PRESS, json.dumps({"deviceId": DEVICE_ID, "action": "archive"}), qos=1)
            time.sleep_ms(50)
        except OSError:
            # Connection dropped: long tone, then retry.
            tone(1200, 220)
            time.sleep(5)
            try:
                wifi_connect()
                client = mqtt_connect()
            except OSError:
                machine.reset()


main()
