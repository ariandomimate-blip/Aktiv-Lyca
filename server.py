import os
from flask import Flask, send_from_directory, jsonify
app=Flask(__name__,static_folder='.',static_url_path='')
BULK=[(10,7.0),(50,5.0),(100,4.5),(200,4.0),(250,3.8),(500,3.5)]
@app.get('/')
def index(): return send_from_directory('.', 'index.html')
@app.get('/api/health')
def health(): return jsonify(ok=True,service='webshop-sim',cryptomus=False)
@app.route('/<path:path>')
def static_files(path): return send_from_directory('.',path)
if __name__=='__main__': app.run(host='0.0.0.0',port=int(os.getenv('PORT','5000')))
