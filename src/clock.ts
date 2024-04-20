import { BigDecimal, BigInt, Bytes, ethereum, log } from "@graphprotocol/graph-ts"
import { ClockTick, Investor } from "../generated/schema"
import { DAY, HOUR, VAULT_SNAPSHOT_PERIODS, INVESTOR_SNAPSHOT_PERIODS, PROTOCOL_SNAPSHOT_PERIODS } from "./utils/time"
import { getClockTick } from "./entity/clock"
import { getBeefyCLProtocol, getBeefyCLProtocolSnapshot } from "./entity/protocol"
import { ZERO_BD } from "./utils/decimal"
import { getToken } from "./entity/token"
import { fetchVaultLatestData } from "./utils/price"
import { getBeefyCLStrategy, getBeefyCLVaultSnapshot, isVaultRunning } from "./entity/vault"
import { getInvestorPositionSnapshot } from "./entity/position"
import { getInvestorSnapshot } from "./entity/investor"
import { DailyAvgCalc, DailyAvgState } from "./utils/daily-avg"

export function handleClockTick(block: ethereum.Block): void {
  const timestamp = block.timestamp

  let tickRes1h = getClockTick(timestamp, HOUR)
  if (!tickRes1h.isNew) {
    log.debug("handleClockTick: tick already exists for 1h period", [])
    return
  }
  tickRes1h.tick.save()

  let tickResDay = getClockTick(timestamp, DAY)
  tickResDay.tick.save()

  updateDataOnClockTick(tickRes1h.tick, tickResDay.isNew)
}

function updateDataOnClockTick(tick: ClockTick, isNewDay: boolean): void {
  const protocol = getBeefyCLProtocol()
  let protocolTotalValueLockedUSD = ZERO_BD
  let protocolActiveVaultCount = 0
  let protocolActiveInvestorCount = 0

  const vaults = protocol.vaults.load()
  const investorTVL = new Map<string, BigDecimal>()

  for (let i = 0; i < vaults.length; i++) {
    const vault = vaults[i]
    if (!isVaultRunning(vault)) {
      continue
    }

    const strategy = getBeefyCLStrategy(vault.strategy)
    const positions = vault.positions.load()
    const sharesToken = getToken(vault.sharesToken)
    const token0 = getToken(vault.underlyingToken0)
    const token1 = getToken(vault.underlyingToken1)
    const earnedToken = getToken(vault.earnedToken)

    ///////
    // fetch data on chain for that vault
    const vaultData = fetchVaultLatestData(vault, strategy, sharesToken, token0, token1, earnedToken)
    const vaultBalanceUnderlying0 = vaultData.token0Balance
    const vaultBalanceUnderlying1 = vaultData.token1Balance
    const currentPriceInToken1 = vaultData.currentPriceInToken1
    const token0PriceInNative = vaultData.token0ToNative
    const token1PriceInNative = vaultData.token1ToNative
    const nativePriceUSD = vaultData.nativeToUsd

    ///////
    // compute derived values
    const token0PriceInUSD = token0PriceInNative.times(nativePriceUSD)
    const token1PriceInUSD = token1PriceInNative.times(nativePriceUSD)

    //////
    // update vault usd values
    vault.currentPriceOfToken0InToken1 = currentPriceInToken1
    vault.currentPriceOfToken0InUSD = token0PriceInUSD
    vault.priceRangeMinUSD = vault.priceRangeMin1.times(token1PriceInUSD)
    vault.priceRangeMaxUSD = vault.priceRangeMax1.times(token1PriceInUSD)
    vault.underlyingAmount0 = vaultBalanceUnderlying0
    vault.underlyingAmount1 = vaultBalanceUnderlying1
    vault.underlyingAmount0USD = vault.underlyingAmount0.times(token0PriceInUSD)
    vault.underlyingAmount1USD = vault.underlyingAmount1.times(token1PriceInUSD)
    vault.totalValueLockedUSD = vault.underlyingAmount0USD.plus(vault.underlyingAmount1USD)
    vault.save()
    // update vault snapshots
    for (let j = 0; j < VAULT_SNAPSHOT_PERIODS.length; j++) {
      const period = VAULT_SNAPSHOT_PERIODS[j]
      const vaultSnapshot = getBeefyCLVaultSnapshot(vault, tick.timestamp, period)
      vaultSnapshot.currentPriceOfToken0InToken1 = vault.currentPriceOfToken0InToken1
      vaultSnapshot.currentPriceOfToken0InUSD = vault.currentPriceOfToken0InUSD
      vaultSnapshot.priceRangeMinUSD = vault.priceRangeMinUSD
      vaultSnapshot.priceRangeMaxUSD = vault.priceRangeMaxUSD
      vaultSnapshot.underlyingAmount0 = vault.underlyingAmount0
      vaultSnapshot.underlyingAmount1 = vault.underlyingAmount1
      vaultSnapshot.underlyingAmount0USD = vault.underlyingAmount0USD
      vaultSnapshot.underlyingAmount1USD = vault.underlyingAmount1USD
      vaultSnapshot.totalValueLockedUSD = vault.totalValueLockedUSD
      vaultSnapshot.save()
    }

    //////
    // keep track of protocol values
    protocolTotalValueLockedUSD = protocolTotalValueLockedUSD.plus(vault.totalValueLockedUSD)
    protocolActiveVaultCount = protocolActiveVaultCount + 1
    for (let j = 0; j < positions.length; j++) {
      const position = positions[j]
      if (position.sharesBalance.equals(ZERO_BD)) {
        continue
      }

      const investor = Investor.load(position.investor)
      if (!investor) {
        continue
      }

      //////
      // update position usd values
      position.underlyingBalance0USD = position.underlyingBalance0.times(token0PriceInUSD)
      position.underlyingBalance1USD = position.underlyingBalance1.times(token1PriceInUSD)
      position.positionValueUSD = position.underlyingBalance0USD.plus(position.underlyingBalance1USD)
      let state = DailyAvgState.deserialize(position.averageDailyPositionValueUSDState)
      if (isNewDay) {
        state.addValue(position.positionValueUSD)
      }
      state.setPendingValue(position.positionValueUSD, tick.timestamp)
      position.averageDailyPositionValueUSD30D = DailyAvgCalc.avg(DAY.times(BigInt.fromU32(30)), state)
      position.averageDailyPositionValueUSDState = state.serialize()
      position.save()
      // update position snapshot
      for (let k = 0; k < INVESTOR_SNAPSHOT_PERIODS.length; k++) {
        const period = INVESTOR_SNAPSHOT_PERIODS[k]
        const positionSnapshot = getInvestorPositionSnapshot(vault, investor, tick.timestamp, period)
        positionSnapshot.underlyingBalance0USD = position.underlyingBalance0USD
        positionSnapshot.underlyingBalance1USD = position.underlyingBalance1USD
        positionSnapshot.positionValueUSD = position.positionValueUSD
        positionSnapshot.save()
      }

      if (!investorTVL.has(investor.id.toHexString())) {
        investorTVL.set(investor.id.toHexString(), ZERO_BD)
      }
      let tvl = investorTVL.get(investor.id.toHexString())
      // @ts-ignore
      tvl = tvl.plus(position.positionValueUSD)
      investorTVL.set(investor.id.toHexString(), tvl)
    }
  }

  // @ts-ignore
  let investorIdStrings: Array<string> = investorTVL.keys()

  // update investor moving averages
  for (let i = 0; i < investorIdStrings.length; i++) {
    const investorIdStr = investorIdStrings[i]
    const id = Bytes.fromHexString(investorIdStr)
    const investor = Investor.load(id)
    if (!investor) {
      continue
    }
    //////
    // keep track of protocol values
    protocolActiveInvestorCount = protocolActiveInvestorCount + 1

    // @ts-ignore
    const tvl: BigDecimal = investorTVL.get(investorIdStr)
    investor.totalPositionValueUSD = tvl

    let state = DailyAvgState.deserialize(investor.averageDailyTotalPositionValueUSDState)
    if (isNewDay) {
      state.addValue(tvl)
    }
    state.setPendingValue(tvl, tick.timestamp)
    investor.averageDailyTotalPositionValueUSD30D = DailyAvgCalc.avg(DAY.times(BigInt.fromU32(30)), state)
    investor.averageDailyTotalPositionValueUSDState = DailyAvgCalc.evictOldEntries(
      BigInt.fromU32(30),
      state,
    ).serialize()
    investor.save()
    for (let j = 0; j < INVESTOR_SNAPSHOT_PERIODS.length; j++) {
      const period = INVESTOR_SNAPSHOT_PERIODS[j]
      const investorSnapshot = getInvestorSnapshot(investor, tick.timestamp, period)
      investorSnapshot.totalPositionValueUSD = tvl
      investorSnapshot.save()
    }
  }

  ///////
  // update protocol values
  protocol.totalValueLockedUSD = protocolTotalValueLockedUSD
  protocol.activeVaultCount = protocolActiveVaultCount
  protocol.activeInvestorCount = protocolActiveInvestorCount
  protocol.save()
  for (let i = 0; i < PROTOCOL_SNAPSHOT_PERIODS.length; i++) {
    const period = PROTOCOL_SNAPSHOT_PERIODS[i]
    const protocolSnapshot = getBeefyCLProtocolSnapshot(tick.timestamp, period)
    protocolSnapshot.totalValueLockedUSD = protocol.totalValueLockedUSD
    protocolSnapshot.activeVaultCount = protocol.activeVaultCount
  }
}
