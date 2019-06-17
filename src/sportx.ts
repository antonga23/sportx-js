import debug from "debug";
import { utils, Wallet } from "ethers";
import {
  bigNumberify,
  formatUnits,
  isHexString,
  randomBytes
} from "ethers/utils";
import fetch from "node-fetch";
import io from "socket.io-client";
import {
  Environments,
  PRODUCTION_RELAYER_URL,
  RELAYER_HTTP_ENDPOINTS,
  RELAYER_TIMEOUT,
  RINKEBY_RELAYER_URL,
  WEBSOCKET_MESSAGE_KEYS
} from "./constants";
import { APIError } from "./errors/api_error";
import { APITimeoutError } from "./errors/api_timeout_error";
import { APISchemaError } from "./errors/schema_error";
import {
  IRelayerCancelOrderRequest,
  IRelayerNewMakerOrder,
  IRelayerPendingUnsettledBet,
  ISignedRelayerNewMakerOrder
} from "./types/internal";
import {
  IAPIOrder,
  IAPIResponse,
  ILeague,
  IMarket,
  IMetadata,
  INewOrder,
  IPendingBet,
  ISport
} from "./types/public";
import { convertToDecimalOdds, convertToDisplayAmount } from "./utils/convert";
import { getOrderSignature } from "./utils/signing";
import {
  isAddress,
  validateINewOrderSchema,
  validateOrderHashArray
} from "./utils/validation";

export interface ISportX {
  init(): Promise<void>;
  getMetadata(): Promise<IMetadata>;
  getLeagues(): Promise<ILeague[]>;
  getSports(): Promise<ISport[]>;
  getActiveMarkets(): Promise<IMarket[]>;
  newOrder(order: INewOrder): Promise<IAPIResponse>;
  cancelOrder(orderHashes: string[]): Promise<IAPIResponse>;
  getRecentPendingBets(address: string): Promise<IPendingBet[]>;
  getOrders(marketHash: string): Promise<IAPIOrder[]>;
  getActiveOrders(account: string): Promise<IAPIOrder[]>;
}

class SportX implements ISportX {
  private signingWallet: Wallet;
  private relayerUrl: string;
  private initialized: boolean = false;
  private clientSocket!: SocketIOClient.Socket;
  private debug = debug("sportx-js");
  private metadata!: IMetadata;

  constructor(env: Environments, privateKey: string) {
    this.signingWallet = new Wallet(privateKey);
    if (env === Environments.PRODUCTION) {
      this.relayerUrl = PRODUCTION_RELAYER_URL;
    } else if (env === Environments.RINKEBY) {
      this.relayerUrl = RINKEBY_RELAYER_URL;
    } else {
      throw new Error(`Invalid environment: ${env}`);
    }
  }

  public async init() {
    if (this.initialized) {
      throw new Error("Already initialized");
    }
    await new Promise((resolve, reject) => {
      this.clientSocket = io(this.relayerUrl, { transports: ["websocket"] });
      this.clientSocket.on("connect", () => {
        resolve();
        setTimeout(
          () => reject(new Error("Timeout connecting to the SportX API")),
          RELAYER_TIMEOUT
        );
      });
    });
    this.initialized = true;
    this.metadata = await this.getMetadata();
    this.debug("Initialized");
  }

  public async getMetadata(): Promise<IMetadata> {
    const metadata = await new Promise((resolve, reject) => {
      this.clientSocket.on(
        WEBSOCKET_MESSAGE_KEYS.METADATA,
        (data: IMetadata) => {
          this.debug("Got metadata");
          this.debug(data);
          resolve(data);
        }
      );
      this.clientSocket.emit(
        WEBSOCKET_MESSAGE_KEYS.METADATA,
        null,
        (response: any) => {
          if (response.status !== "success") {
            reject(new Error("Error getting metadata from the SportX API"));
          }
        }
      );
      setTimeout(
        () =>
          reject(
            new APITimeoutError("Timeout getting metadata from the SportX API")
          ),
        RELAYER_TIMEOUT
      );
    });
    return metadata as IMetadata;
  }

  public async getLeagues(): Promise<ILeague[]> {
    const response = await fetch(
      `${this.relayerUrl}${RELAYER_HTTP_ENDPOINTS.LEAGUES}`
    );
    const { data } = await response.json();
    return data as ILeague[];
  }

  public async getSports(): Promise<ISport[]> {
    const response = await fetch(
      `${this.relayerUrl}${RELAYER_HTTP_ENDPOINTS.SPORTS}`
    );
    const { data } = await response.json();
    return data as ISport[];
  }

  public async getActiveMarkets(): Promise<IMarket[]> {
    const markets = await new Promise((resolve, reject) => {
      this.clientSocket.on(
        WEBSOCKET_MESSAGE_KEYS.ACTIVE_MARKETS,
        (data: IMarket[]) => {
          this.debug("Got active markets");
          this.debug(data);
          resolve(data);
        }
      );
      this.clientSocket.emit(
        WEBSOCKET_MESSAGE_KEYS.ACTIVE_MARKETS,
        null,
        (response: any) => {
          if (response.status !== "success") {
            reject(
              new Error(
                `Error getting active markets. Reason: ${response.reason}`
              )
            );
          }
          setTimeout(
            () =>
              reject(
                new APITimeoutError(
                  "Timeout getting active markets from the SportX API"
                )
              ),
            RELAYER_TIMEOUT
          );
        }
      );
    });
    return markets as IMarket[];
  }

  public async newOrder(order: INewOrder) {
    const schemaValidation = validateINewOrderSchema(order);
    if (schemaValidation !== "OK") {
      throw new APISchemaError(schemaValidation);
    }
    const bigNumBetSize = bigNumberify(order.totalBetSize);
    const makerOrderMinimumBigNum = bigNumberify(
      this.metadata.makerOrderMinimum
    );
    if (bigNumBetSize.lt(makerOrderMinimumBigNum)) {
      throw new APISchemaError(
        `totalBetSize below API minimum of ${formatUnits(
          makerOrderMinimumBigNum,
          18
        )}`
      );
    }
    const salt = bigNumberify(randomBytes(32)).toString();
    const apiMakerOrder: IRelayerNewMakerOrder = {
      marketHash: order.marketHash,
      maker: this.signingWallet.address,
      totalBetSize: bigNumBetSize.toString(),
      percentageOdds: order.percentageOdds,
      expiry: order.expiry.toString(),
      relayerTakerFee: this.metadata.fees.relayerTakerFee,
      relayerMakerFee: this.metadata.fees.relayerMakerFee,
      executor: this.metadata.executorAddress,
      relayer: this.metadata.relayerAddress,
      salt,
      isMakerBettingOutcomeOne: order.isMakerBettingOutcomeOne
    };
    const signature = await getOrderSignature(
      apiMakerOrder,
      this.signingWallet
    );
    const signedApiMakerOrder: ISignedRelayerNewMakerOrder = {
      ...apiMakerOrder,
      signature
    };
    const status = await new Promise((resolve, reject) => {
      this.clientSocket.emit(
        WEBSOCKET_MESSAGE_KEYS.NEW_ORDER,
        signedApiMakerOrder,
        (response: IAPIResponse) => {
          if (response.status === "success") {
            resolve(response);
          } else {
            reject(
              new APIError(
                `Unable to create new order. Status: ${
                  response.status
                }. Reason: ${response.reason}`
              )
            );
          }
        }
      );
      setTimeout(
        () =>
          reject(
            new APITimeoutError(
              "Timeout getting submitting order to the SportX API"
            )
          ),
        RELAYER_TIMEOUT
      );
    });
    return status as IAPIResponse;
  }

  public async cancelOrder(orderHashes: string[]) {
    const schemaValidation = validateOrderHashArray(orderHashes);
    if (schemaValidation !== "OK") {
      throw new APISchemaError(schemaValidation);
    }
    const signingPayload = utils.solidityKeccak256(
      [...orderHashes.map(() => "bytes32"), "bool"],
      [...orderHashes, true]
    );
    const cancelSignature = await this.signingWallet.signMessage(
      utils.arrayify(signingPayload)
    );
    const payload: IRelayerCancelOrderRequest = {
      orderHashes,
      cancelSignature
    };
    const status = await new Promise((resolve, reject) => {
      this.clientSocket.emit(
        WEBSOCKET_MESSAGE_KEYS.CANCEL_ORDER,
        payload,
        (response: IAPIResponse) => {
          if (response.status === "success") {
            resolve(response);
          } else {
            reject(
              new APIError(
                `Unable to cancel order. Status: ${response.status}. Reason: ${
                  response.reason
                }`
              )
            );
          }
        }
      );
      setTimeout(
        () =>
          reject(
            new APITimeoutError(
              "Timeout getting submitting order to the SportX API"
            )
          ),
        RELAYER_TIMEOUT
      );
    });
    return status as IAPIResponse;
  }

  public async getRecentPendingBets(address: string): Promise<IPendingBet[]> {
    if (!isAddress(address)) {
      throw new APISchemaError(`Address ${address} is not a valid address`);
    }
    const response = await fetch(
      `${this.relayerUrl}${RELAYER_HTTP_ENDPOINTS.PENDING_BETS}/${address}`
    );
    const { data } = await response.json();
    const pendingBets: IRelayerPendingUnsettledBet[] = data;
    const formattedPendingBets = pendingBets.map(bet => ({
      marketHashes: bet.marketHashes,
      impliedOdds: bet.percentageOdds.map(odd =>
        convertToDecimalOdds(bigNumberify(odd))
      ),
      isMakerBettingOutcomeOne: bet.isMakerBettingOutcomeOne,
      taker: bet.taker,
      fillAmounts: bet.fillAmounts.map(amount =>
        Number(convertToDisplayAmount(bigNumberify(amount)))
      ),
      orderHashes: bet.orderHashes,
      status: bet.status,
      betTime: bet.betTime
    }));
    return formattedPendingBets;
  }

  public async getOrders(marketHash: string): Promise<IAPIOrder[]> {
    if (!isHexString(marketHash)) {
      throw new APISchemaError(
        `Market hash ${marketHash} is not a valid hash string.`
      );
    }
    const response = await fetch(
      `${this.relayerUrl}${RELAYER_HTTP_ENDPOINTS.ORDERS}/${marketHash}`
    );
    const { data } = await response.json();
    const orders: IAPIOrder[] = data;
    return orders;
  }

  public async getActiveOrders(account: string): Promise<IAPIOrder[]> {
    if (!isAddress(account)) {
      throw new APISchemaError(`Address ${account} is not a valid address`);
    }
    const response = await fetch(
      `${this.relayerUrl}${RELAYER_HTTP_ENDPOINTS.ACTIVE_ORDERS}/${account}`
    );
    const { data } = await response.json();
    const orders: IAPIOrder[] = data;
    return orders;
  }
}

export async function newSportX(env: Environments, privateKey: string) {
  const sportX = new SportX(env, privateKey);
  await sportX.init();
  return sportX;
}
