// server.js
const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const crypto = require('crypto');

const app = express();
app.use(express.static('public')); // serves index.html and assets in public/

const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

const PORT = process.env.PORT || 3000;

function makeId(len=6){ return crypto.randomBytes(len).toString('hex').slice(0,len); }

// Game state: rooms -> players, bullets, feed
const rooms = new Map(); // roomCode -> {players: Map, bullets: [], feed: [], map:{w,h}}

function createRoomIfMissing(code){
  if(!rooms.has(code)){
    rooms.set(code, {
      players: new Map(),
      bullets: [],
      feed: [],
      map: { w: 1200, h: 800 } // map boundaries
    });
  }
}

function broadcastToRoom(room, obj){
  const str = JSON.stringify(obj);
  for(const player of room.players.values()){
    if(player.ws.readyState === WebSocket.OPEN) player.ws.send(str);
  }
}

wss.on('connection', (ws) => {
  // store small session:
  const session = { ws, id: makeId(4), roomCode: null };

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch(e){ return; }

    // join lobby / create room
    if(msg.type === 'create_room'){
      const code = makeId(3);
      createRoomIfMissing(code);
      session.roomCode = code;
      const room = rooms.get(code);

      // add player
      const p = {
        id: session.id,
        ws,
        name: msg.name || 'Player',
        skin: msg.skin || Math.floor(Math.random()*6),
        x: Math.random()*(room.map.w-200)+100,
        y: Math.random()*(room.map.h-200)+100,
        vx:0, vy:0, angle:0,
        health: 100,
        weapon: 'pistol',
        lastShot: 0,
        grenades: 1,
        kills: 0
      };
      room.players.set(session.id, p);

      // tell creator
      ws.send(JSON.stringify({ type: 'room_created', room: code }));
      // announce
      broadcastToRoom(room, { type: 'sys', msg: `${p.name} joined the room.` });
    }

    if(msg.type === 'join_room'){
      const code = msg.room;
      if(!rooms.has(code)){
        ws.send(JSON.stringify({ type:'err', msg:'Room not found' }));
        return;
      }
      session.roomCode = code;
      const room = rooms.get(code);
      const p = {
        id: session.id,
        ws,
        name: msg.name || 'Player',
        skin: msg.skin || Math.floor(Math.random()*6),
        x: Math.random()*(room.map.w-200)+100,
        y: Math.random()*(room.map.h-200)+100,
        vx:0, vy:0, angle:0,
        health: 100,
        weapon: 'pistol',
        lastShot: 0,
        grenades: 1,
        kills: 0
      };
      room.players.set(session.id, p);
      ws.send(JSON.stringify({ type:'joined', room: code }));
      broadcastToRoom(room, { type: 'sys', msg: `${p.name} joined the room.` });
    }

    if(msg.type === 'chat'){
      const room = rooms.get(session.roomCode);
      if(!room) return;
      broadcastToRoom(room, { type:'chat', from: msg.from, text: msg.text });
    }

    if(msg.type === 'input'){
      const room = rooms.get(session.roomCode);
      if(!room) return;
      const player = room.players.get(session.id);
      if(!player) return;
      // apply simple input: velocities and shooting
      player.input = msg.input; // store raw input for server tick
      player.angle = msg.input.mouseAngle || player.angle;
      // shooting (client requests shoot) -> server spawns bullet (rate-limited)
      if(msg.input.shoot && Date.now() - player.lastShot > 150){
        player.lastShot = Date.now();
        const speed = player.weapon === 'sniper' ? 18 : 10;
        room.bullets.push({
          x: player.x + Math.cos(player.angle)*20,
          y: player.y + Math.sin(player.angle)*20,
          dx: Math.cos(player.angle)*speed,
          dy: Math.sin(player.angle)*speed,
          owner: session.id,
          ttl: 3000
        });
      }
      // grenade throw
      if(msg.input.grenade && player.grenades > 0 && !player._lastGrenadeAt){
        player._lastGrenadeAt = Date.now();
        player.grenades--;
        // create a grenade as a slow bullet with explosion delay
        room.bullets.push({
          x: player.x + Math.cos(player.angle)*20,
          y: player.y + Math.sin(player.angle)*20,
          dx: Math.cos(player.angle)*6,
          dy: Math.sin(player.angle)*6,
          owner: session.id,
          ttl: 2200,
          grenade: true
        });
      }
    }
  });

  ws.on('close', () => {
    if(session.roomCode){
      const room = rooms.get(session.roomCode);
      if(room){
        room.players.delete(session.id);
        broadcastToRoom(room, { type:'sys', msg: `A player left` });
        // remove room if empty
        if(room.players.size === 0) rooms.delete(session.roomCode);
      }
    }
  });
});

// game loop ~20Hz
setInterval(() => {
  for(const room of rooms.values()){
    // update players from input
    for(const player of room.players.values()){
      const i = player.input || {};
      const speed = 160; // px/sec
      const dt = 50/1000;
      let dx = 0, dy = 0;
      if(i.left) dx -= speed*dt;
      if(i.right) dx += speed*dt;
      if(i.up) dy -= speed*dt;
      if(i.down) dy += speed*dt;
      player.x += dx; player.y += dy;
      // clamp to boundaries
      player.x = Math.max(20, Math.min(room.map.w-20, player.x));
      player.y = Math.max(20, Math.min(room.map.h-20, player.y));
    }

    // update bullets
    for(let i = room.bullets.length-1; i>=0; i--){
      const b = room.bullets[i];
      b.x += b.dx;
      b.y += b.dy;
      b.ttl -= 50;
      // grenade explosion when ttl <= 0 and grenade flag
      if(b.ttl <= 0){
        if(b.grenade){
          // apply area damage
          for(const p of room.players.values()){
            const dx = p.x - b.x, dy = p.y - b.y;
            const d2 = dx*dx + dy*dy;
            if(d2 < 150*150){
              p.health -= 40 * (1 - Math.sqrt(d2)/(150));
              if(p.health <= 0){
                p.health = 0;
                // respawn
                p.x = Math.random()*(room.map.w-200)+100;
                p.y = Math.random()*(room.map.h-200)+100;
                // credit kill to grenade owner if any
                const owner = room.players.get(b.owner);
                if(owner) owner.kills++;
                room.feed.push(`${owner?owner.name:'Someone'} killed a player with grenade`);
              }
            }
          }
        }
        // remove bullet
        room.bullets.splice(i,1);
        continue;
      }
      // check bullet collisions with players
      for(const p of room.players.values()){
        if(p.id === b.owner) continue;
        const dx = p.x - b.x, dy = p.y - b.y;
        if(dx*dx + dy*dy < 16*16){
          p.health -= 30;
          if(p.health <= 0){
            p.health = 0;
            // credit kill
            const owner = room.players.get(b.owner);
            if(owner){ owner.kills++; room.feed.push(`${owner.name} killed ${p.name}`); }
            // respawn victim
            p.x = Math.random()*(room.map.w-200)+100;
            p.y = Math.random()*(room.map.h-200)+100;
            p.health = 100;
          }
          // remove bullet
          room.bullets.splice(i,1);
          break;
        }
      }
      // remove if off map or ttl expired
      if(b && (b.x < -50 || b.x > room.map.w+50 || b.y < -50 || b.y > room.map.h+50 || b.ttl <= 0)){
        const idx = room.bullets.indexOf(b);
        if(idx >= 0) room.bullets.splice(idx,1);
      }
    }

    // keep feed short
    if(room.feed.length > 20) room.feed.splice(0, room.feed.length-20);

    // send snapshot
    const snapshot = {
      type: 'snapshot',
      players: Array.from(room.players.values()).map(p => ({
        id: p.id, x:p.x, y:p.y, angle:p.angle, health:p.health, skin:p.skin, name:p.name, kills:p.kills, grenades:p.grenades
      })),
      bullets: room.bullets.map(b => ({x:b.x,y:b.y,grenade:!!b.grenade})),
      feed: room.feed.slice(-10),
      map: room.map
    };
    broadcastToRoom(room, snapshot);
  }
}, 50);

server.listen(PORT, () => {
  console.log('Server listening on', PORT);
});
