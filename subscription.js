
/**
 * Module dependencies.
 */

var EventEmitter = require('events').EventEmitter
  , debug = require('debug')('mydb-subscription');

/**
 * Subscription.
 *
 * @param {Server} server
 * @param {String} subscription id
 * @api public
 */

function Subscription(server, id){
  this.server = server;
  this.redis = server.redis;
  this.sub = server.redisSub;
  this.mongo = server.mongo;
  this.id = id;
  this.get();
  this.ops = [];
  this.onMessage = this.onMessage.bind(this);
  this.once('payload', this.emitOps.bind(this));
}

/**
 * Inherits from `EventEmitter`.
 */

Subscription.prototype.__proto__ = EventEmitter.prototype;

/**
 * Retrieves the document id and fields from redis.
 *
 * @api private
 */

Subscription.prototype.get = function(){
  var self = this;
  this.readyState = 'discoverying';
  this.redis.get(this.id, function(err, data){
    if (err) return self.emit('error', err);
    var obj;
    try {
      obj = JSON.parse(data);
    } catch(e) {
      return self.emit('error', err);
    }
    self.oid = data.i;
    self.fields = data.f || {};
    self.col = data.c;
    self.subscribe();
  });
};

/**
 * Subscribes to redis.
 *
 * @api private
 */

Subscription.prototype.subscribe = function(){
  var self = this;
  this.readyState = 'subscribing';
  this.sub.subscribe(this.id, function(err){
    if (err) return self.emit('error', err);
    self.readyState = 'subscribed';
    self.fetch();
  });
  this.sub.on('message', this.onMessage);
};

/**
 * Fetch the payload.
 *
 * @api private
 */

Subscription.prototype.fetch = function(){
  var opts = { fields: this.fields };
  var self = this;
  this.mongo.get(this.col).findById(this.id, opts, function(err, doc){
    if ('subscribed' != self.readyState) return;
    if (err) return self.emit('error', err);
    if (!doc) {
      var err = 'Document "' + self.col + '.' + self.id + '" not found';
      return self.emit('error', new Error(err));
    }
    debug('retrieved document "%s.%s"', self.col, self.id);
    self.payload = doc;
    self.emit('payload', doc);
  });
};

/**
 * Called for all subscriptions messages.
 *
 * @api private
 */

Subscription.prototype.onMessage = function(channel, message){
  if (this.id == channel) {
    var obj;

    try {
      obj = JSON.parse(message);
    } catch(e){
      this.emit('error', e);
      return;
    }

    if (this.payload) {
      this.emit('op', obj);
    } else {
      // if the payload is not set yet, we buffer op events
      this.ops.push(obj);
    }
  }
};

/**
 * Emits buffered `op` events.
 *
 * @api private
 */

Subscription.prototype.emitOps = function(){
  if (this.ops.length) {
    for (var i = 0; i < this.ops.length; i++) {
      this.emit('op', this.ops[i]);
    }
    this.ops = [];
  }
};

/**
 * Destroys the subscription.
 *
 * @api private
 */

Subscription.prototype.destroy = function(){
  if ('subscribing' == this.readyState || 'subscribed' == this.readyState) {
    var self = this;
    this.readyState = 'unsubscribing';
    this.ops = null;
    this.payload = null;
    this.sub.unsubscribe(this.id, function(err){
      if (err) return self.emit('error', err);
      self.readyState = 'unsubscribed';
    });
    this.sub.removeListener('message', this.onMessage);
  } else {
    debug('ignoring destroy - current state is "%s"', this.readyState);
  }
};