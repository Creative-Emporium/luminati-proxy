#!/usr/bin/env node
// LICENSE_CODE ZON ISC
'use strict'; /*jslint node:true, esnext:true*/
const _ = require('lodash');
const dns = require('dns');
const http = require('http');
const rand = require('../util/rand.js');
const etask = require('../util/etask.js');
const zws = require('../util/ws.js');
const date = require('../util/date.js');
const zerr = require('../util/zerr.js');
const logger = require('./logger.js').child({category: 'MNGR: lpm_f'});
const util_lib = require('./util.js');
const perr = require('./perr.js');

const Lpm_f = etask._class(class Lpm_f {
    constructor(mgr){
        this.mgr = mgr;
        this.argv = mgr.argv;
        this.errors = 0;
        this.ever_connected = false;
        this.sync_recent_stats = _.throttle(this.update_stats, date.ms.MIN);
    }
    *init(_this){
        _this.uri_ws = `ws://zagent75.${_this.mgr._defaults.api_domain}`;
        _this.ws = new zws.Client(_this.uri_ws, {
            label: 'lpm_f',
            agent: new http.Agent({
                lookup: (hostname, opt, cb)=>{
                    const _opt = Object.assign({}, opt,
                        {family: 4, all: true});
                    dns.lookup(hostname, _opt, (err, res)=>{
                        if (err)
                            return cb(err);
                        const {address, family=4} = rand.rand_element(res)||{};
                        cb(undefined, address, family);
                    });
                },
            }),
            ipc_client: {
                hello: 'post',
                reset_auth: 'post',
                auth: {type: 'call', timeout: 30*date.ms.SEC},
                update_conf: {type: 'call', timeout: 30*date.ms.SEC},
                get_conf: {type: 'call', timeout: 30*date.ms.SEC},
                get_meta_conf: {type: 'call', timeout: 30*date.ms.SEC},
                update_stats: {type: 'call', timeout: 30*date.ms.SEC},
                resolve_proxies: {type: 'call', timeout: 30*date.ms.SEC},
            },
        })
        .on('connected', ()=>_this.on_connected(this))
        .on('disconnected', _this.on_disconnected.bind(_this))
        .on('json', _this.on_json.bind(_this));
        yield this.wait();
        _this.ever_connected = true;
    }
    *on_connected(_this, et){
        this.on('uncaught', e=>{
            logger.error('on_connected: %s', zerr.e2s(e));
            et.throw(e);
        });
        logger.notice('Connection established');
        yield _this.ws.ipc.hello();
        if (_this.ever_connected)
        {
            let auth_conf;
            if (auth_conf = yield _this.login())
                yield _this.mgr.apply_cloud_config(auth_conf);
        }
        et.continue();
    }
    *on_json(_this, data){
        this.on('uncaught', e=>logger.error('json %s', zerr.e2s(e)));
        if (!data || !data.msg)
            return;
        if (data.msg=='new_conf')
            yield _this.mgr.apply_cloud_config(data.new_conf);
        else if (data.msg=='zones')
            _this.mgr.apply_zones_config(data.zones);
        else if (data.msg=='server_conf')
        {
            logger.notice('Updated server configuration');
            _this.mgr.server_conf = data.server_conf;
        }
    }
    on_disconnected(){
        logger.warn('Connection failed');
        this.errors++;
        if (this.errors>1 && !this.ever_connected)
        {
            logger.warn('Could not establish WS connection to '+this.uri_ws);
            this.ws.close();
        }
    }
    close(){
        if (this.ws)
            this.ws.close();
        if (this.sync_recent_stats)
            this.sync_recent_stats.cancel();
    }
    connected(){
        return this.ws && this.ws.connected;
    }
    *login(_this){
        this.on('uncaught', e=>{
            logger.error('login %s', zerr.e2s(e));
            util_lib.perr('error', {error: zerr.e2s(e), ctx: 'lpm_f login'});
        });
        const lpm_token = _this.mgr._defaults.lpm_token;
        if (!_this.connected() || !lpm_token)
            return;
        const auth_res = yield _this.ws.ipc.auth({lpm_token});
        if (auth_res.err)
        {
            logger.warn('Authentication failed: '+auth_res.err);
            return false;
        }
        logger.notice('Authentication success');
        return auth_res.config;
    }
    *logout(_this){
        this.on('uncaught', e=>logger.error('logout %s', zerr.e2s(e)));
        if (!_this.connected())
            return;
        yield _this.ws.ipc.reset_auth();
    }
    *update_conf(_this, config){
        this.on('uncaught', e=>logger.warn('update_conf %s', e.message));
        const lpm_token = _this.mgr._defaults.lpm_token;
        if (!_this.connected() || !lpm_token)
            return;
        const change = Object.assign({}, _this.mgr.config_changes);
        _this.mgr.config_changes = {};
        const resp = yield _this.ws.ipc.update_conf({
            lpm_token,
            config,
            change,
        });
        if (resp && resp.err)
            throw new Error(resp.err);
    }
    *get_conf(_this, opt={}){
        this.on('uncaught', e=>logger.error('get_conf %s', zerr.e2s(e)));
        const lpm_token = _this.mgr._defaults.lpm_token;
        if (!_this.connected() || !lpm_token)
            return;
        const resp = yield _this.ws.ipc.get_conf({lpm_token});
        if (!opt.retried && resp && resp.err=='not_authorized')
        {
            const auth_conf = yield _this.login();
            return auth_conf||{};
        }
        return resp && resp.config || {};
    }
    *get_meta_conf(_this){
        if (!_this.connected())
            throw new Error('no_lpm_f_conn');
        const opt = {zagent: _this.argv.zagent};
        const resp = yield _this.ws.ipc.get_meta_conf(opt);
        if (!resp || !resp.config)
            throw new Error(resp && resp.err || 'unknown err from lpm_f');
        return resp.config;
    }
    *update_stats(_this){
        this.on('uncaught', e=>{
            logger.error('update_stats %s', zerr.e2s(e));
        });
        if (!_this.argv.sync_stats)
            return;
        const stats = _this.mgr.loki.stats_get();
        const lpm_token = _this.mgr._defaults.lpm_token;
        if (!_this.connected() || !lpm_token)
            return;
        const resp = yield _this.ws.ipc.update_stats({
            lpm_token,
            stats,
            uuid: perr.uuid,
        });
        if (resp && resp.err)
            throw new Error(resp.err);
    }
    *resolve_proxies(_this, opt={}){
        this.on('uncaught', e=>{
            logger.error('update_stats %s', zerr.e2s(e));
            this.return([]);
        });
        const resp = yield _this.ws.ipc.resolve_proxies({
            limit: 20,
            cn: !!opt.cn,
        });
        if (!resp || !resp.proxies)
            throw new Error(resp && resp.err || 'unknown err from lpm_f');
        return resp.proxies;
    }
});

module.exports = Lpm_f;
