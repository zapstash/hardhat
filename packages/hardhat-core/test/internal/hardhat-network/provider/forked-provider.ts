import { assert } from "chai";
import { BN, bufferToHex, toBuffer } from "ethereumjs-util";
// tslint:disable-next-line:no-implicit-dependencies
import { Contract, utils, Wallet } from "ethers";
import fsExtra from "fs-extra";

import {
  numberToRpcQuantity,
  rpcDataToBN,
  rpcQuantityToBN,
  rpcQuantityToNumber,
} from "../../../../src/internal/core/jsonrpc/types/base-types";
import { InvalidInputError } from "../../../../src/internal/core/providers/errors";
import { ALCHEMY_URL } from "../../../setup";
import { workaroundWindowsCiFailures } from "../../../utils/workaround-windows-ci-failures";
import {
  assertQuantity,
  assertTransactionFailure,
} from "../helpers/assertions";
import {
  BITFINEX_WALLET_ADDRESS,
  BLOCK_NUMBER_OF_10496585,
  DAI_ADDRESS,
  EMPTY_ACCOUNT_ADDRESS,
  FIRST_TX_HASH_OF_10496585,
  UNISWAP_FACTORY_ADDRESS,
  WETH_ADDRESS,
} from "../helpers/constants";
import { EXAMPLE_CONTRACT } from "../helpers/contracts";
import { setCWD } from "../helpers/cwd";
import { EthersProviderWrapper } from "../helpers/ethers-provider-wrapper";
import { hexStripZeros } from "../helpers/hexStripZeros";
import { leftPad32 } from "../helpers/leftPad32";
import {
  DEFAULT_ACCOUNTS,
  DEFAULT_ACCOUNTS_ADDRESSES,
  FORKED_PROVIDERS,
} from "../helpers/providers";
import { retrieveForkBlockNumber } from "../helpers/retrieveForkBlockNumber";
import { deployContract } from "../helpers/transactions";

const ERC20Abi = fsExtra.readJsonSync(`${__dirname}/../abi/ERC20/ERC20.json`);
const UniswapExchangeAbi = fsExtra.readJsonSync(
  `${__dirname}/../abi/Uniswap/Exchange.json`
);
const UniswapFactoryAbi = fsExtra.readJsonSync(
  `${__dirname}/../abi/Uniswap/Factory.json`
);

const WETH_DEPOSIT_SELECTOR = "0xd0e30db0";

describe("Forked provider", function () {
  FORKED_PROVIDERS.forEach(({ rpcProvider, useProvider }) => {
    workaroundWindowsCiFailures({ isFork: true });

    describe(`Using ${rpcProvider}`, function () {
      setCWD();
      useProvider();

      const getForkBlockNumber = async () =>
        retrieveForkBlockNumber(this.ctx.hardhatNetworkProvider);

      describe("eth_blockNumber", () => {
        it("returns the current block number", async function () {
          const blockNumber = await this.provider.send("eth_blockNumber");
          const minBlockNumber = 10494745; // mainnet block number at 20.07.2020
          assert.isAtLeast(rpcQuantityToNumber(blockNumber), minBlockNumber);
        });
      });

      describe("eth_call", function () {
        it("can get DAI total supply", async function () {
          const daiTotalSupplySelector = "0x18160ddd";
          const result = await this.provider.send("eth_call", [
            { to: DAI_ADDRESS.toString(), data: daiTotalSupplySelector },
          ]);

          const bnResult = new BN(toBuffer(result));
          assert.isTrue(bnResult.gtn(0));
        });

        describe("when used in the context of a past block", () => {
          describe("when the block number is greater than the fork block number", () => {
            it("does not affect previously added data", async function () {
              const forkBlockNumber = await getForkBlockNumber();

              const contractAddress = await deployContract(
                this.provider,
                `0x${EXAMPLE_CONTRACT.bytecode.object}`
              );

              const firstState = leftPad32("0xdeadbeef");
              await this.provider.send("eth_sendTransaction", [
                {
                  to: contractAddress,
                  from: DEFAULT_ACCOUNTS_ADDRESSES[0],
                  data: EXAMPLE_CONTRACT.selectors.modifiesState + firstState,
                },
              ]);

              const temporaryState = leftPad32("0xfeedface");
              await this.provider.send("eth_call", [
                {
                  to: contractAddress,
                  from: DEFAULT_ACCOUNTS_ADDRESSES[0],
                  data:
                    EXAMPLE_CONTRACT.selectors.modifiesState + temporaryState,
                },
                numberToRpcQuantity(forkBlockNumber + 1),
              ]);

              assert.equal(
                await this.provider.send("eth_call", [
                  {
                    to: contractAddress,
                    data: EXAMPLE_CONTRACT.selectors.i,
                    from: DEFAULT_ACCOUNTS_ADDRESSES[0],
                  },
                  "latest",
                ]),
                `0x${firstState}`
              );
            });
          });

          describe("when the block number is less or equal to the fork block number", () => {
            it("does not affect previously added storage data", async function () {
              const forkBlockNumber = await getForkBlockNumber();
              await this.provider.send("hardhat_impersonateAccount", [
                BITFINEX_WALLET_ADDRESS.toString(),
              ]);

              const getWrappedBalance = async () => {
                const balanceOfSelector = `0x70a08231${leftPad32(
                  BITFINEX_WALLET_ADDRESS.toString()
                )}`;
                return rpcDataToBN(
                  await this.provider.send("eth_call", [
                    { to: WETH_ADDRESS.toString(), data: balanceOfSelector },
                  ])
                ).toString();
              };

              await this.provider.send("eth_sendTransaction", [
                {
                  from: BITFINEX_WALLET_ADDRESS.toString(),
                  to: WETH_ADDRESS.toString(),
                  data: WETH_DEPOSIT_SELECTOR,
                  value: numberToRpcQuantity(123),
                  gas: numberToRpcQuantity(50000),
                  gasPrice: numberToRpcQuantity(1),
                },
              ]);
              const balance = await getWrappedBalance();

              await this.provider.send("eth_call", [
                {
                  from: BITFINEX_WALLET_ADDRESS.toString(),
                  to: WETH_ADDRESS.toString(),
                  data: WETH_DEPOSIT_SELECTOR,
                  value: numberToRpcQuantity(321),
                },
                numberToRpcQuantity(forkBlockNumber - 3),
              ]);

              assert.equal(await getWrappedBalance(), balance);
            });

            it("does not affect previously added balance data", async function () {
              const forkBlockNumber = await getForkBlockNumber();
              await this.provider.send("hardhat_impersonateAccount", [
                BITFINEX_WALLET_ADDRESS.toString(),
              ]);

              await this.provider.send("eth_sendTransaction", [
                {
                  from: BITFINEX_WALLET_ADDRESS.toString(),
                  to: EMPTY_ACCOUNT_ADDRESS.toString(),
                  value: numberToRpcQuantity(123),
                  gas: numberToRpcQuantity(21000),
                  gasPrice: numberToRpcQuantity(1),
                },
              ]);

              await this.provider.send("eth_call", [
                {
                  from: BITFINEX_WALLET_ADDRESS.toString(),
                  to: EMPTY_ACCOUNT_ADDRESS.toString(),
                  value: numberToRpcQuantity(321),
                },
                numberToRpcQuantity(forkBlockNumber - 1),
              ]);

              const balance = await this.provider.send("eth_getBalance", [
                EMPTY_ACCOUNT_ADDRESS.toString(),
              ]);
              assert.equal(rpcQuantityToNumber(balance), 123);
            });
          });
        });
      });

      describe("eth_getBalance", function () {
        it("can get the balance of the WETH contract", async function () {
          const result = await this.provider.send("eth_getBalance", [
            WETH_ADDRESS.toString(),
          ]);
          assert.isTrue(rpcQuantityToBN(result).gtn(0));
        });
      });

      describe("eth_sendTransaction", () => {
        it("supports Ether transfers to remote accounts", async function () {
          const result = await this.provider.send("eth_getBalance", [
            BITFINEX_WALLET_ADDRESS.toString(),
          ]);
          const initialBalance = rpcQuantityToBN(result);
          await this.provider.send("eth_sendTransaction", [
            {
              from: DEFAULT_ACCOUNTS_ADDRESSES[0],
              to: BITFINEX_WALLET_ADDRESS.toString(),
              value: numberToRpcQuantity(100),
              gas: numberToRpcQuantity(21000),
              gasPrice: numberToRpcQuantity(1),
            },
          ]);
          const balance = await this.provider.send("eth_getBalance", [
            BITFINEX_WALLET_ADDRESS.toString(),
          ]);
          assertQuantity(balance, initialBalance.addn(100));
        });

        it("supports wrapping of Ether", async function () {
          const wethBalanceOfSelector = `0x70a08231${leftPad32(
            DEFAULT_ACCOUNTS_ADDRESSES[0]
          )}`;

          const getWrappedBalance = async () =>
            rpcDataToBN(
              await this.provider.send("eth_call", [
                { to: WETH_ADDRESS.toString(), data: wethBalanceOfSelector },
              ])
            );

          const initialBalance = await getWrappedBalance();
          await this.provider.send("eth_sendTransaction", [
            {
              from: DEFAULT_ACCOUNTS_ADDRESSES[0],
              to: WETH_ADDRESS.toString(),
              data: WETH_DEPOSIT_SELECTOR,
              value: numberToRpcQuantity(100),
              gas: numberToRpcQuantity(50000),
              gasPrice: numberToRpcQuantity(1),
            },
          ]);
          const balance = await getWrappedBalance();
          assert.equal(
            balance.toString("hex"),
            initialBalance.addn(100).toString("hex")
          );
        });
      });

      describe("eth_getTransactionByHash", () => {
        it("supports local transactions", async function () {
          const transactionHash = await this.provider.send(
            "eth_sendTransaction",
            [
              {
                from: DEFAULT_ACCOUNTS_ADDRESSES[0],
                to: DEFAULT_ACCOUNTS_ADDRESSES[1],
                value: numberToRpcQuantity(1),
                gas: numberToRpcQuantity(21000),
                gasPrice: numberToRpcQuantity(1),
              },
            ]
          );

          const transaction = await this.provider.send(
            "eth_getTransactionByHash",
            [transactionHash]
          );

          assert.equal(transaction.from, DEFAULT_ACCOUNTS_ADDRESSES[0]);
          assert.equal(transaction.to, DEFAULT_ACCOUNTS_ADDRESSES[1]);
          assert.equal(transaction.value, numberToRpcQuantity(1));
          assert.equal(transaction.gas, numberToRpcQuantity(21000));
          assert.equal(transaction.gasPrice, numberToRpcQuantity(1));
        });

        it("supports remote transactions", async function () {
          const transaction = await this.provider.send(
            "eth_getTransactionByHash",
            [bufferToHex(FIRST_TX_HASH_OF_10496585)]
          );

          assert.equal(
            transaction.from,
            "0x4e87582f5e48f3e505b7d3b544972399ad9f2e5f"
          );
          assert.equal(
            transaction.to,
            "0xdac17f958d2ee523a2206206994597c13d831ec7"
          );
        });
      });

      describe("eth_getTransactionCount", () => {
        it("should have a non-zero nonce for the first unlocked account", async function () {
          // this test works because the first unlocked accounts used by these
          // tests happen to have transactions in mainnet
          const [account] = await this.provider.send("eth_accounts");

          const transactionCount = await this.provider.send(
            "eth_getTransactionCount",
            [account]
          );

          assert.isTrue(rpcQuantityToBN(transactionCount).gtn(0));
        });
      });

      describe("eth_getTransactionReceipt", () => {
        it("supports local transactions", async function () {
          const transactionHash = await this.provider.send(
            "eth_sendTransaction",
            [
              {
                from: DEFAULT_ACCOUNTS_ADDRESSES[0],
                to: DEFAULT_ACCOUNTS_ADDRESSES[1],
                value: numberToRpcQuantity(1),
                gas: numberToRpcQuantity(21000),
                gasPrice: numberToRpcQuantity(1),
              },
            ]
          );

          const receipt = await this.provider.send(
            "eth_getTransactionReceipt",
            [transactionHash]
          );

          assert.equal(receipt.from, DEFAULT_ACCOUNTS_ADDRESSES[0]);
          assert.equal(receipt.to, DEFAULT_ACCOUNTS_ADDRESSES[1]);
          assert.equal(receipt.gasUsed, numberToRpcQuantity(21000));
        });

        it("supports remote transactions", async function () {
          const receipt = await this.provider.send(
            "eth_getTransactionReceipt",
            [bufferToHex(FIRST_TX_HASH_OF_10496585)]
          );

          assert.equal(
            receipt.from,
            "0x4e87582f5e48f3e505b7d3b544972399ad9f2e5f"
          );
          assert.equal(
            receipt.to,
            "0xdac17f958d2ee523a2206206994597c13d831ec7"
          );
        });
      });

      describe("eth_getLogs", () => {
        it("can get remote logs", async function () {
          const logs = await this.provider.send("eth_getLogs", [
            {
              fromBlock: numberToRpcQuantity(BLOCK_NUMBER_OF_10496585),
              toBlock: numberToRpcQuantity(BLOCK_NUMBER_OF_10496585),
            },
          ]);

          assert.equal(logs.length, 205);
        });
      });

      describe("evm_revert", () => {
        it("can revert the state of WETH contract to a previous snapshot", async function () {
          const getWethBalance = async () =>
            this.provider.send("eth_getBalance", [WETH_ADDRESS.toString()]);

          const initialBalance = await getWethBalance();
          const snapshotId = await this.provider.send("evm_snapshot", []);
          await this.provider.send("eth_sendTransaction", [
            {
              from: DEFAULT_ACCOUNTS_ADDRESSES[0],
              to: WETH_ADDRESS.toString(),
              data: WETH_DEPOSIT_SELECTOR,
              value: numberToRpcQuantity(100),
              gas: numberToRpcQuantity(50000),
              gasPrice: numberToRpcQuantity(1),
            },
          ]);
          assert.notEqual(await getWethBalance(), initialBalance);

          const reverted = await this.provider.send("evm_revert", [snapshotId]);
          assert.isTrue(reverted);
          assert.equal(await getWethBalance(), initialBalance);
        });
      });

      describe("hardhat_impersonateAccount", () => {
        const oneEtherQuantity = numberToRpcQuantity(
          new BN(10).pow(new BN(18))
        );

        it("allows to impersonate a remote EOA", async function () {
          await this.provider.send("hardhat_impersonateAccount", [
            BITFINEX_WALLET_ADDRESS.toString(),
          ]);

          await this.provider.send("eth_sendTransaction", [
            {
              from: BITFINEX_WALLET_ADDRESS.toString(),
              to: EMPTY_ACCOUNT_ADDRESS.toString(),
              value: oneEtherQuantity,
              gas: numberToRpcQuantity(21000),
              gasPrice: numberToRpcQuantity(1),
            },
          ]);
          const balance = await this.provider.send("eth_getBalance", [
            EMPTY_ACCOUNT_ADDRESS.toString(),
          ]);
          assert.equal(balance, oneEtherQuantity);
        });

        it("allows to impersonate a remote contract account", async function () {
          // Get Uniswap DAI exchange address
          const getExchangeSelector = `0x06f2bf62${leftPad32(
            DAI_ADDRESS.toString()
          )}`;
          const result = await this.provider.send("eth_call", [
            {
              to: UNISWAP_FACTORY_ADDRESS.toString(),
              data: getExchangeSelector,
            },
          ]);
          const daiExchangeAddress = hexStripZeros(result);

          // Impersonate the DAI exchange contract
          await this.provider.send("hardhat_impersonateAccount", [
            daiExchangeAddress,
          ]);

          // Transfer 10^18 DAI from the exchange contract to the EMPTY_ACCOUNT_ADDRESS
          const transferRawData = `0xa9059cbb${leftPad32(
            EMPTY_ACCOUNT_ADDRESS.toString()
          )}${leftPad32(oneEtherQuantity)}`;

          await this.provider.send("eth_sendTransaction", [
            {
              from: daiExchangeAddress,
              to: DAI_ADDRESS.toString(),
              gas: numberToRpcQuantity(200_000),
              gasPrice: numberToRpcQuantity(1),
              data: transferRawData,
            },
          ]);

          // Check DAI balance of EMPTY_ACCOUNT_ADDRESS
          const balanceOfSelector = `0x70a08231${leftPad32(
            EMPTY_ACCOUNT_ADDRESS.toString()
          )}`;

          const daiBalance = await this.provider.send("eth_call", [
            { to: DAI_ADDRESS.toString(), data: balanceOfSelector },
          ]);

          assert.equal(hexStripZeros(daiBalance), oneEtherQuantity);
        });
      });

      describe("hardhat_stopImpersonatingAccount", () => {
        it("disables account impersonating", async function () {
          await this.provider.send("hardhat_impersonateAccount", [
            BITFINEX_WALLET_ADDRESS.toString(),
          ]);
          await this.provider.send("hardhat_stopImpersonatingAccount", [
            BITFINEX_WALLET_ADDRESS.toString(),
          ]);

          await assertTransactionFailure(
            this.provider,
            {
              from: BITFINEX_WALLET_ADDRESS.toString(),
              to: EMPTY_ACCOUNT_ADDRESS.toString(),
              value: numberToRpcQuantity(100),
              gas: numberToRpcQuantity(21000),
              gasPrice: numberToRpcQuantity(1),
            },
            "unknown account",
            InvalidInputError.CODE
          );
        });
      });

      describe("Tests on remote contracts", () => {
        describe("Uniswap", () => {
          let wallet: Wallet;
          let factory: Contract;
          let daiExchange: Contract;
          let dai: Contract;

          beforeEach(async function () {
            const ethersProvider = new EthersProviderWrapper(this.provider);
            wallet = new Wallet(DEFAULT_ACCOUNTS[0].privateKey, ethersProvider);

            factory = new Contract(
              UNISWAP_FACTORY_ADDRESS.toString(),
              UniswapFactoryAbi,
              ethersProvider
            );

            const daiExchangeAddress = await factory.getExchange(
              DAI_ADDRESS.toString()
            );

            daiExchange = new Contract(
              daiExchangeAddress,
              UniswapExchangeAbi,
              wallet
            );

            dai = new Contract(
              DAI_ADDRESS.toString(),
              ERC20Abi,
              ethersProvider
            );
          });

          it("can buy DAI for Ether", async function () {
            const ethBefore = await wallet.getBalance();
            const daiBefore = await dai.balanceOf(wallet.address);
            assert.equal(daiBefore.toNumber(), 0);

            const expectedDai = await daiExchange.getEthToTokenInputPrice(
              utils.parseEther("0.5")
            );
            assert.isTrue(expectedDai.gt(0));

            await daiExchange.ethToTokenSwapInput(
              1, // min amount of token retrieved
              2525644800, // random timestamp in the future (year 2050)
              {
                gasLimit: 4000000,
                value: utils.parseEther("0.5"),
              }
            );

            const ethAfter = await wallet.getBalance();
            const daiAfter = await dai.balanceOf(wallet.address);

            const ethLost = parseFloat(
              utils.formatUnits(ethBefore.sub(ethAfter), "ether")
            );

            assert.equal(daiAfter.toString(), expectedDai.toString());
            assert.closeTo(ethLost, 0.5, 0.001);
          });
        });
      });

      describe("blocks timestamps", () => {
        it("should use a timestamp relative to the forked block timestamp", async function () {
          if (ALCHEMY_URL === undefined) {
            this.skip();
          }

          await this.provider.send("hardhat_reset", [
            {
              forking: {
                jsonRpcUrl: ALCHEMY_URL,
                blockNumber: 11565019, // first block of 2021
              },
            },
          ]);

          await this.provider.send("evm_mine");

          const block = await this.provider.send("eth_getBlockByNumber", [
            "latest",
            false,
          ]);

          const timestamp = rpcQuantityToNumber(block.timestamp);
          const date = new Date(timestamp * 1000);

          // check that the new block date is 2021-Jan-01
          assert.equal(date.getUTCDate(), 1);
          assert.equal(date.getUTCMonth(), 0);
          assert.equal(date.getUTCFullYear(), 2021);
        });
      });
    });
  });
});
