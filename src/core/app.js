'use strict';

import cluster from 'cluster';
import fs from 'fs';
import domain from 'domain';
import os from 'os';
import http from 'http';

export default class extends think.base {
  /**
   * exec logic
   * @return {Promise} []
   */
  execLogic(){
    let name = `${this.http.module}/${think.dirname.logic}/${this.http.controller}`;
    let cls = think.require(name, true);
    if (!cls) {
      return Promise.resolve();
    }
    let instance = new cls(this.http);
    let action = this.http.action;
    if (think.isFunction(instance[`${action}Action`])) {
      return this.action(instance, action);
    }
    //call action
    else if (think.isFunction(instance.__call)) {
      return this.action(instance, '__call');
    }
    //only has before method
    else if(think.isFunction(instance.__before)){
      return instance.__before(instance);
    }
  }
  /**
   * exec controller
   * @return {Promise} []
   */
  execController(){
    let http = this.http;
    let name = `${http.module}/${think.dirname.controller}/${http.controller}`;
    let cls = think.require(name, true);
    if (cls) {
      return this.execAction(new cls(http));
    }
    http.error = new Error(think.locale('CONTROLLER_NOT_FOUND', http.controller, http.url));
    return think.statusAction(404, http);
  }
  /**
   * exec action
   * @param  {Object} controller [controller instance]
   * @param  {Boolean} call       [is call controller]
   * @return {Promise}            []
   */
  execAction(controller, isCall){
    if(isCall){
      return this.action(controller, think.config('call_action'));
    }
    let http = this.http;
    //if is rest api, rewrite action
    if(controller.__isRest){
      http.action = http.method.toLowerCase();
    }
    let action = http.action;
    let actionWithSuffix = `${action}Action`;
    //action is exist
    if(think.isFunction(controller[actionWithSuffix])){
      return this.action(controller, action);
    }
    //call action
    if(think.isFunction(controller.__call)){
      return this.action(controller, '__call');
    }
    http.error = new Error(think.locale('ACTION_NOT_FOUND', action, http.url));
    return think.statusAction(404, http);
  }
  /**
   * exec 
   * @return {Promise} []
   */
  async exec(){
    await this.execLogic();
    //http is end
    if (this.http._isEnd) {
      return think.prevent();
    }
    return this.execController();
  }
  /**
   * run
   * @return {} []
   */
  run(){
    let http = this.http;
    http.header('X-Powered-By', `thinkjs-${think.version}`);
    //service off
    if(!think.config('service_on')){
      http.error = new Error(think.locale('SERVICE_UNAVAILABLE'));
      return think.statusAction(503, http, true);
    }
    //deny access by ip + port
    if (think.config('proxy_on') && http.host !== http.hostname && !http.socket) {
      http.error = new Error(think.locale('DISALLOW_PORT'));
      return think.statusAction(403, http);
    }
    
    let instance = domain.create();
    instance.on('error', err => {
      http.error = err;
      think.statusAction(500, http, true);
    });
    instance.run(async () => {
      try{
        await this.hook('resource_check');
        await this.hook('route_parse');
        //set module config, can not set config in request
        this.http._config = think.getModuleConfig(this.http.module);
        await this.hook('app_begin');
        await this.exec();
        await this.hook('app_end');
      }catch(err){
        http.error = err;
        think.statusAction(500, http, true);
      }
    });
  }
  /**
   * create server
   * @return {} []
   */
  static createServer(){
    let handle = think.config('create_server');
    let host = think.config('host');
    let port = think.port || think.config('port'); 
    //createServer callback
    let callback = async (req, res) => {
      let http = await think.http(req, res);
      return new this(http).run();
    };
    let server;
    //define createServer in application
    if (handle) {
      server = handle(callback, port, host, this);
    }else{
      //create server
      server = http.createServer(callback);
      server.listen(port, host);
    }
    this.logPid(port);

    //start websocket
    let websocket = think.config('websocket');
    if(websocket.on){
      let Cls = think.adapter('websocket', websocket.type);
      let instance = new Cls(server, websocket, this);
      instance.run();
    }
  }
  /**
   * log
   * @return {} []
   */
  static log(){
    let host = think.config('host');
    let port = think.port || think.config('port'); 
    let websocketStatus = think.config('websocket.on') ? 'open' : 'closed';
    let clusterStatus = think.config('cluster_on') ? 'open' : 'closed';

    think.log('Server running at http://' + (host || '127.0.0.1') + ':' + port + '/', 'THINK');
    think.log(() => `ThinkJS Version: ${think.version}`, 'THINK');
    think.log(colors => `Cluster Status: ${colors.magenta(clusterStatus)}`, 'THINK');
    think.log(colors => `WebSocket Status: ${colors.magenta(websocketStatus)}`, 'THINK');
    think.log(colors => `File Auto Reload: ${colors.magenta(think.config('auto_reload'))}`, 'THINK');
    think.log(colors => `App Enviroment: ${colors.magenta(think.env)}\n`, 'THINK');
  }
  /**
   * cli mode
   * @return {} []
   */
  static async cli(){
    let http = await think.http(think.cli);
    return new this(http).run();
  }
  /**
   * load process id
   * @return {} []
   */
  static logPid(port){
    if (!cluster.isMaster || !think.config('log_pid')) {
      return;
    }
    let dir = think.getPath(undefined, think.dirname.runtime) + '/pid';
    think.mkdir(dir);
    let pidFile = `${dir}/${port}.pid`;
    fs.writeFileSync(pidFile, process.pid);
    //change pid file mode
    think.chmod(pidFile);
    //remove pid file when process exit
    process.on('SIGTERM', () => {
      if (fs.existsSync(pidFile)) {
        fs.unlinkSync(pidFile);
      }
      process.exit(0);
    });
  }
  /**
   * http mode
   * @return {} []
   */
  static http(){
    let nums = think.config('cluster_on');
    if (!nums) {
      this.createServer();
      return this.log();
    }
    if (nums === true) {
      nums = os.cpus().length;
    }
    if (cluster.isMaster) {
      for (let i = 0; i < nums; i++) {
        cluster.fork();
      }
      cluster.on('exit', worker => {
        think.log(new Error(think.locale('WORKER_DIED', worker.process.pid)), 'THINK');
        process.nextTick(() => cluster.fork());
      });
      this.log();
    }else {
      this.createServer();
    }
  }
  /**
   * run
   * @return {} []
   */
  static run(){
    if (think.cli) {
      return this.cli();
    }
    return this.http();
  }
}