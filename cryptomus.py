import os, json, base64, hashlib, hmac, uuid
import requests
from flask import request, jsonify
MERCHANT=os.getenv('CRYPTOMUS_MERCHANT_ID','').strip(); KEY=os.getenv('CRYPTOMUS_PAYMENT_API_KEY','').strip(); API='https://api.cryptomus.com/v1'
def _sign(raw): return hashlib.md5(base64.b64encode(raw)+KEY.encode()).hexdigest()
def register_cryptomus(app, catalog):
    @app.post('/api/checkout')
    def checkout():
        if not MERCHANT or not KEY: return jsonify(error='Cryptomus ist noch nicht konfiguriert.'),503
        data=request.get_json(silent=True) or {}; items=data.get('items') or []; total=0
        for x in items:
            q=int(x.get('qty',0)); p=catalog.get(str(x.get('id')))
            if not p or q<1: return jsonify(error='Ungültiger Warenkorb.'),400
            total += float(p['unit_price'](q))*q
        if total<=0: return jsonify(error='Warenkorb ist leer.'),400
        oid='SIM-'+uuid.uuid4().hex[:16]; base=request.host_url.rstrip('/')
        payload={'amount':f'{total:.2f}','currency':'EUR','order_id':oid,'url_return':base,'url_success':base,'url_callback':base+'/api/cryptomus/webhook','lifetime':3600}
        raw=json.dumps(payload,separators=(',',':')).encode()
        try: r=requests.post(API+'/payment',data=raw,headers={'merchant':MERCHANT,'sign':_sign(raw),'Content-Type':'application/json'},timeout=20); d=r.json()
        except requests.RequestException as e: return jsonify(error='Cryptomus ist nicht erreichbar.',detail=str(e)),502
        if not r.ok or d.get('state')!=0: return jsonify(error=d.get('message','Rechnung konnte nicht erstellt werden.')),502
        return jsonify(order_id=oid,total=round(total,2),checkout_url=(d.get('result') or {}).get('url'))
    @app.post('/api/cryptomus/webhook')
    def webhook():
        data=request.get_json(silent=True) or {}; received=data.get('sign')
        if not received: return jsonify(error='Missing signature'),403
        unsigned=dict(data); unsigned.pop('sign',None); raw=json.dumps(unsigned,separators=(',',':'),ensure_ascii=False).encode()
        if not hmac.compare_digest(received,_sign(raw)): return jsonify(error='Invalid signature'),403
        app.logger.info('Cryptomus SIM order %s => %s',data.get('order_id'),data.get('status')); return jsonify(ok=True)
