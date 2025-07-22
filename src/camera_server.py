from flask import Flask, render_template
# On Raspberry Pi
# sudo apt update
# sudo apt install -y python3-pip libatlas-base-dev libjpeg-dev
# pip3 install picamera flask qrcode[pil]
from picamera import PiCamera
from time import sleep
import io
import base64

app = Flask(__name__)
camera = PiCamera()

@app.route('/')
def scan_qr():
    return render_template('scan.html')

@app.route('/capture')
def capture():
    stream = io.BytesIO()
    camera.capture(stream, 'jpeg')
    stream.seek(0)
    return base64.b64encode(stream.read()).decode('utf-8')

if __name__ == '__main__':
    app.run(host='0.0.0.0', port=5001)
    
    
# PHYSICAL STATION SET UP REQUIRES THE FOLLOWING HARDWARE:
#    - Raspberry Pi 4 (or newer)
#    - Official Raspberry Pi Camera Module
#    - Power supply and case
#    - Portable battery pack (for field use)