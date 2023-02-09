import { Knex } from 'knex';
import { IContext } from '../server/context';
import { mysqlDateConvert } from './utils';
import { PocketSaveStatus } from '../types';

export type RawListResult = {
  api_id: string;
  api_id_updated: number;
  favorite: number;
  given_url: string;
  item_id: number;
  resolved_id: number;
  status: number;
  time_added: Date;
  time_favorited: Date;
  time_read: Date;
  time_updated: Date;
  title: string;
  user_id: number;
};

export type ListResult = {
  api_id: string;
  api_id_updated: number;
  favorite: number;
  given_url: string;
  item_id: number;
  resolved_id: number;
  status: keyof typeof PocketSaveStatus;
  time_added: Date;
  time_favorited: Date;
  time_read: Date;
  time_updated: Date;
  title: string;
  user_id: number;
};

/**
 * Make PocketSaveStatus enums
 * to the desired status string.
 */
const statusMap = {
  [PocketSaveStatus.UNREAD]: 'UNREAD',
  [PocketSaveStatus.ARCHIVED]: 'ARCHIVED',
  [PocketSaveStatus.DELETED]: 'DELETED',
  [PocketSaveStatus.HIDDEN]: 'HIDDEN',
};

/**
 * Convert the given raw MySQL list row into the desired list row types.
 * Converts status ints into desired PocketSaveStatus enum strings.
 * Converts MySQL date responses into validated Typescript Date objects,
 * filtering out (returning null) values like '0000-00-00 00:00:00'.
 * @param row
 */
const convert = (row: RawListResult) => {
  const result: ListResult = {
    api_id: row.api_id,
    api_id_updated: row.api_id_updated,
    favorite: row.favorite,
    given_url: row.given_url,
    item_id: row.item_id,
    resolved_id: row.resolved_id,
    status: statusMap[row.status],
    time_added: mysqlDateConvert(row.time_added),
    time_favorited: mysqlDateConvert(row.time_favorited),
    time_read: mysqlDateConvert(row.time_read),
    time_updated: mysqlDateConvert(row.time_updated),
    title: row.title,
    user_id: row.user_id,
  };
  return result;
};

/***
 * class that handles the read and write from `readitla-temp.list` table
 * note: for mutations, please pass the writeClient, otherwise there will be replication lags.
 */
export class PocketSaveDataService {
  private db: Knex;
  private readonly apiId: string;
  private readonly userId: string;

  constructor(context: Pick<IContext, 'apiId' | 'dbClient' | 'userId'>) {
    this.apiId = context.apiId;
    this.db = context.dbClient;
    this.userId = context.userId;
  }

  public static convertListResult(listResult: null): null;
  public static convertListResult(listResult: RawListResult): ListResult;
  public static convertListResult(listResult: RawListResult[]): ListResult[];
  /**
   * Convert the `status` field in the list table to the expected
   * GraphQL ENUM string
   * @param listResult
   */
  public static convertListResult(
    listResult: RawListResult | RawListResult[] | null
  ): ListResult | ListResult[] | null {
    if (listResult === undefined || listResult === null) {
      return null;
    }

    if (listResult instanceof Array) {
      return listResult.map((row) => convert(row));
    }
    return convert(listResult);
  }

  /**
   * Helper function to build repeated queries, for DRY pocketSave and pocketSaves fetches.
   * Will eventually be extended for building filter, sorts, etc. for different pagination, etc.
   * For now just to reuse the same query and reduce testing burden :)
   */
  public buildQuery(): any {
    return this.db('list').select(
      'api_id',
      'api_id_updated',
      'favorite',
      'given_url',
      'item_id',
      'resolved_id',
      'status',
      'time_added',
      'time_favorited',
      'time_read',
      'time_updated',
      'title',
      'user_id'
    );
  }

  /**
   * Fetch a List Table Row By ID (user id x item_id)
   * @param itemId the pocketSave ID to fetch
   */
  public async getListRowById(itemId: string): Promise<ListResult> {
    const query = await this.buildQuery()
      .where({ user_id: this.userId, item_id: itemId })
      .first();

    const rawResp = query;
    const resp = PocketSaveDataService.convertListResult(rawResp);
    return resp;
  }
}
