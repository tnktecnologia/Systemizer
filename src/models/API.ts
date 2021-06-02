import { IDataOperator, ShowStatusCodeEvent } from "src/interfaces/IDataOperator";
import { Connection } from "./Connection";
import { RequestData } from "./RequestData";
import { Options } from "./Options";
import { Port } from "./Port";
import { EventDispatcher, Handler } from "./Shared/EventDispatcher";
import { arrayEquals, sleep, UUID } from "src/shared/ExtensionMethods";
import { Endpoint, EndpointRef } from "./Endpoint";
import { EndpointOperator, EndpointOptions } from "./EdpointOperator";
import { Protocol } from "./enums/Protocol";
import { EndpointActionHTTPMethod, HTTPMethod } from "./enums/HTTPMethod";
import { HTTPStatus } from "./enums/HTTPStatus";
import { APIType } from "./enums/APIType";
import { gRPCMode } from "./enums/gRPCMode";
import { MessageQueue } from "./MessageQueue";

interface ReceiveDataEvent { }

export class API extends EndpointOperator implements IDataOperator{

    inputPort: Port;
    connectionTable: {[id:string]:Connection} = {};
    options: APIOptions;
    originID: string;

    constructor() {
        super()
        this.inputPort = new Port(this, false, true);        
        this.outputPort = new Port(this, true, true);       
        this.options = new APIOptions(); 
        this.options.title = "API";
        this.originID = UUID();
        let ep = new Endpoint("api/posts", [HTTPMethod.GET,HTTPMethod.POST,HTTPMethod.PUT,HTTPMethod.DELETE,])
        ep.protocol = Protocol.HTTP;
        this.options.endpoints = [
            ep
        ]
    }

    async receiveData(data: RequestData, fromOutput:boolean) {
        if(fromOutput){
            let targetConnection = this.connectionTable[data.responseId]
            if(targetConnection == null) throw new Error("Target connection can not be null")
            this.connectionTable[data.responseId] = null; // reset request id
            this.fireReceiveData(data);
            // API received data from action 
            //this.inputPort.sendData(data,targetConnection);
        }
        else{
            if(data.requestId == "" || data.requestId == null) throw new Error("Request ID can not be null");
            if(data.header.endpoint == null) throw new Error("Endpoint can not be null")

            // Checking for 404 and 405
            let was = false;
            let notAllowed = false;
            let targetEndpoint: Endpoint;
            for(let endpoint of this.options.endpoints){
                if(endpoint.url === data.header.endpoint.endpoint.url){
                    was = true;
                    if(endpoint.supportedMethods.indexOf(data.header.endpoint.method) == -1){
                        notAllowed = true;
                    }
                    else{
                        notAllowed = false;
                        targetEndpoint = endpoint;
                        break;
                    }
                }
            }
            if(!was){
                this.fireShowStatusCode(HTTPStatus["Not Found"])
                return;
            }
            if(notAllowed){
                this.fireShowStatusCode(HTTPStatus["Method Not Allowed"]);
                return;
            }
            if(this.connectionTable[data.requestId] != null){ // The api is already streaming to this connection
                if(targetEndpoint.protocol == Protocol.WebSockets){
                    if(data.header.stream != true){
                        this.connectionTable[data.requestId] = null;
                        return;
                    }
                    else{
                        // Got data from client stream (ws)
                        this.fireReceiveData(data);
                        return;
                    }
                }
                if(targetEndpoint.grpcMode == gRPCMode.Unary){
                    // ??? 
                    throw new Error("Client is conneted to stream, but gRPC mode is on Unary");
                }
                else if(targetEndpoint.grpcMode == gRPCMode["Client Streaming"]){
                    // Got data from client stream 
                    this.fireReceiveData(data);
                    return;
                }
                else if(targetEndpoint.grpcMode == gRPCMode["Server Streaming"]){
                    if(data.header.stream != true){
                        this.connectionTable[data.requestId] = null;
                        return;
                    }
                    else{
                        throw new Error("Client is already connected to server stream, but tries to conncet again, or sends data to server only stram");
                    }
                }
                else if(targetEndpoint.grpcMode == gRPCMode["Bidirectional Streaming"]){
                    if(data.header.stream != true){
                        this.connectionTable[data.requestId] = null;
                        return;
                    }
                    else{
                        // Got data from client stream (grpc bi-stream)
                        this.fireReceiveData(data);
                        return;
                    }
                }
                
            }
            else{
                this.connectionTable[data.requestId] = data.origin;
            }
            this.fireReceiveData(data);
            if(data.header.stream && targetEndpoint.grpcMode == gRPCMode["Client Streaming"] ){
                // Start client streaming 
                return;
            }
            else if((targetEndpoint.grpcMode != gRPCMode.Unary || targetEndpoint.protocol == Protocol.WebSockets) && data.header.stream ){
                // Send data back
                let response = new RequestData();
                response.header = {
                    protocol: Protocol.HTTP,
                    endpoint: data.header.endpoint,
                    stream: true
                };
                response.data = {};
                response.origin = data.origin;
                response.originID = this.originID;
                response.responseId = data.requestId;
                await this.stream(response, targetEndpoint);
                return;
            }


            // Send data to every action
            for(let action of targetEndpoint.actions){
                // Get connection to given action endpoint
                if(action.endpoint == null || action.endpoint.url == null){
                    continue;
                }
                let targetConnection: Connection;
                let has = false;
                for(let connection of this.outputPort.connections){
                    if(has)break;
                    for(let x of connection.getOtherPort(this.outputPort).parent.getAvailableEndpoints()){
                        if(has)break;
                        if(action.endpoint.url===x.url &&  arrayEquals(x.supportedMethods,action.endpoint.supportedMethods)){
                            has = true;
                            targetConnection = connection;
                        } 
                    }      
                }
                if(targetConnection == null){
                    continue;
                }
                // Create new data package
                let request = new RequestData();
                let epRef = new EndpointRef();
                epRef.endpoint = action.endpoint;
                epRef.method = EndpointActionHTTPMethod[action.method] == "Inherit" ? data.header.endpoint.method : HTTPMethod[EndpointActionHTTPMethod[action.method]]
                request.header = {
                    protocol: action.endpoint.protocol,
                    endpoint: epRef,
                    //method: EndpointActionHTTPMethod[action.method] == "Inherit" ? data.header.endpoint.method : HTTPMethod[EndpointActionHTTPMethod[action.method]]
                };
                request.data = {};
                request.origin = targetConnection;
                request.originID = this.originID;
                request.requestId = UUID();

                this.connectionTable[request.requestId] = request.origin;

                await this.outputPort.sendData(request, targetConnection);
            }

            // Send data back
            if(!this.options.isConsumer){
                let response = new RequestData();
                response.header = {
                    protocol: Protocol.HTTP,
                    endpoint: data.header.endpoint,
                };
                response.data = {};
                response.origin = data.origin;
                response.originID = this.originID;
                response.requestId = UUID();
                response.responseId = data.requestId;
                await this.sendData(response);
            }
        }
    }

    private receiveDataDispatcher = new EventDispatcher<ReceiveDataEvent>();
    public onReceiveData(handler: Handler<ReceiveDataEvent>) {
        this.receiveDataDispatcher.register(handler);
    }
    private fireReceiveData(event: ReceiveDataEvent) { 
        this.receiveDataDispatcher.fire(event);
    }
    
    private showStatusCodeDispatcher = new EventDispatcher<ShowStatusCodeEvent>();
    public onShowStatusCode(handler: Handler<ShowStatusCodeEvent>) {
        this.showStatusCodeDispatcher.register(handler);
    }
    private fireShowStatusCode(event: ShowStatusCodeEvent) { 
        this.showStatusCodeDispatcher.fire(event);
    }

    initiateConsumer(consumerConnection: Connection){
        while(this.inputPort.connections.length > 1){
            for(let connection of this.inputPort.connections){
                if(connection !== consumerConnection){
                    this.inputPort.removeConnection(connection,true,false);
                }
            }
        }
        this.options.isConsumer = true;
        this.inputPort.hasMultipleConnections = false;
        this.options.endpoints = [
            (consumerConnection.getOtherPort(this.inputPort).parent.options as EndpointOptions).endpoints[0]
        ]
    }

    onConnectionRemove(wasOutput: boolean = false){
        if(this.options.isConsumer && !this.isConsumer()){
            this.options.isConsumer = false;
            this.inputPort.hasMultipleConnections = true;
            let ep = new Endpoint("api/posts", [HTTPMethod.GET,HTTPMethod.POST,HTTPMethod.PUT,HTTPMethod.DELETE,])
            ep.protocol = Protocol.HTTP;
            this.options.endpoints = [
                ep
            ]
        }
    }

    isConsumer(){
        if(this.inputPort.connections.length == 1 && this.inputPort.connections[0].getOtherPort(this.inputPort).parent instanceof MessageQueue){
            return true;
        }
        return false;
    }

    getConsumingEndpoint() : Endpoint{
        if(!this.options.isConsumer || this.inputPort.connections.length == 0){
            return null;
        }
        return (this.inputPort.connections[0].getOtherPort(this.inputPort).parent.options as EndpointOptions).endpoints[0];
    }

    async sendData(response: RequestData) {
        let targetConnection = this.connectionTable[response.responseId]
        if(targetConnection == null){
            throw new Error("target connection is null")
        }
        if(response.header.stream != true) this.connectionTable[response.responseId] = null; // reset request id
        let res = await this.inputPort.sendData(response, targetConnection);
        if(!res && response.header.stream){
            this.connectionTable[response.responseId] = null
        }
    }

    async stream(data: RequestData, streamingEndpoint: Endpoint){
        await sleep(700);
        if(this.connectionTable[data.responseId] == null ||(
            streamingEndpoint.grpcMode != gRPCMode["Server Streaming"] &&
            streamingEndpoint.grpcMode != gRPCMode["Bidirectional Streaming"] && 
            streamingEndpoint.protocol != Protocol.WebSockets) ||
            this.options.endpoints.indexOf(streamingEndpoint) == -1) return;
        await this.sendData(data);
        await this.stream(data, streamingEndpoint);
    }

    connectTo(operator: IDataOperator, connectingWithOutput:boolean, connectingToOutput:boolean) : Connection{
        if(connectingWithOutput){
            return this.outputPort.connectTo(operator.getPort(connectingToOutput));
        }
        let conn = this.inputPort.connectTo(operator.getPort(connectingToOutput));
        if(conn != null && operator instanceof MessageQueue){
            this.initiateConsumer(conn);
        }
        return conn;
    }

    getPort(outputPort:boolean=false) : Port {
        if(outputPort){
            return this.outputPort;
        }
        return this.inputPort;
    }

    getAvailableEndpoints(): Endpoint[]
    {
        return this.options.endpoints;
    }

    destroy(){
        this.inputPort.removeConnections();
        this.outputPort.removeConnections();
    }
}

export class APIOptions extends EndpointOptions{
    type: APIType = APIType.REST
    isConsumer = false;
}