import { BigInt, Bytes } from '@graphprotocol/graph-ts'
import { BeefyCLVault, Investor, InvestorPosition, InvestorPositionSnapshot } from '../../generated/schema'
import { ADDRESS_ZERO } from '../utils/address'
import { ZERO_BD, ZERO_BI } from '../utils/decimal'
import { getIntervalFromTimestamp } from '../utils/time'

export function getInvestorPosition(vault: BeefyCLVault, investor: Investor): InvestorPosition {
  let id = vault.id.concat(investor.id)
  let position = InvestorPosition.load(id)
  if (!position) {
    position = new InvestorPosition(id)
    position.vault = vault.id
    position.investor = investor.id
    position.createdWith = ADDRESS_ZERO
    position.sharesBalance = ZERO_BD
    position.underlyingBalance0 = ZERO_BD
    position.underlyingBalance1 = ZERO_BD
    position.underlyingBalance0USD = ZERO_BD
    position.underlyingBalance1USD = ZERO_BD
    position.positionValueUSD = ZERO_BD
    position.timeWeightedPositionValueUSD = ZERO_BD
    position.lastUpdated = ZERO_BI
    position.totalActiveTime = ZERO_BI
  }
  return position
}

export function getInvestorPositionSnapshot(
  vault: BeefyCLVault,
  investor: Investor,
  timestamp: BigInt,
  period: BigInt,
): InvestorPositionSnapshot {
  const interval = getIntervalFromTimestamp(timestamp, period)
  const positionId = vault.id.concat(investor.id)
  const snapshotId = positionId
    .concat(Bytes.fromByteArray(Bytes.fromBigInt(period)))
    .concat(Bytes.fromByteArray(Bytes.fromBigInt(interval)))
  let snapshot = InvestorPositionSnapshot.load(snapshotId)
  if (!snapshot) {
    snapshot = new InvestorPositionSnapshot(snapshotId)
    snapshot.investorPosition = positionId
    snapshot.timestamp = timestamp
    snapshot.roundedTimestamp = interval
    snapshot.period = period
    snapshot.sharesBalance = ZERO_BD
    snapshot.underlyingBalance0 = ZERO_BD
    snapshot.underlyingBalance1 = ZERO_BD
    snapshot.underlyingBalance0USD = ZERO_BD
    snapshot.underlyingBalance1USD = ZERO_BD
    snapshot.positionValueUSD = ZERO_BD
  }
  return snapshot
}