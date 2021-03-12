/*
*
* Helper class for converting from upload plan to mapping tree
* (internal structure used in wbplanview) and vice versa
*
* */

'use strict';

import dataModelStorage from './wbplanviewmodel';
import {
  formatReferenceItem,
  formatTreeRank,
  getNameFromTreeRankName,
  tableIsTree,
  valueIsReferenceItem,
  valueIsTreeRank,
}                       from './wbplanviewmodelhelper';
import { MappingsTree, MappingsTreeNode } from './wbplanviewtreehelper';
import { DataModelFieldWritable }          from './wbplanviewmodelfetcher';
import { defaultLineOptions } from './components/wbplanviewmapper';
import { getMappingLineData } from './wbplanviewnavigator';

export type MatchBehaviors = 'ignoreWhenBlank'
  | 'ignoreAlways'
  | 'ignoreNever';

type UploadPlanUploadTableField = string |
  {
    column: string,
    matchBehavior: MatchBehaviors,
    nullAllowed: boolean,
    default: string | null,
  };

type UploadPlanUploadTableFields = Record<string,
  UploadPlanUploadTableField>

type UploadPlanUploadTableStatic =
  Record<string, string | boolean | number>


type UploadPlanUploadTableToMany =
  Omit<UploadPlanUploadTableTable, 'toMany'>

type UploadPlanFieldGroupTypes =
  'wbcols'
  | 'static'
  | 'toOne' |
  'toMany'

type UploadPlanTableGroup<GROUP_NAME extends UploadPlanFieldGroupTypes> =
  GROUP_NAME extends 'wbcols' ? UploadPlanUploadTableFields :
    GROUP_NAME extends 'static' ? UploadPlanUploadTableStatic :
      GROUP_NAME extends 'toOne' ? UploadPlanUploadable :
        UploadPlanUploadTableToMany

interface UploadPlanUploadTableTable {
  wbcols: UploadPlanUploadTableFields,
  static: UploadPlanUploadTableStatic,
  toOne: UploadPlanUploadable,
  toMany: UploadPlanUploadTableToMany,
}

interface UploadPlanTreeRecord {
  ranks: UploadPlanTreeRecordRanks,
}

type UploadPlanTreeRecordRanks = Record<string,
  string | {
  treeNodeCols: UploadPlanUploadTableFields
}>

type UploadPlanUploadtableTypes =
  {'uploadTable': UploadPlanUploadTableTable}
  | {'oneToOneTable': UploadPlanUploadTableTable}
  | {'mustMatchTable': UploadPlanUploadTableTable};

type UploadPlanTreeTypes =
  {'treeRecord': UploadPlanTreeRecord}
  | {'mustMatchTreeRecord': UploadPlanTreeRecord};

type UploadPlanUploadable =
  UploadPlanUploadtableTypes |
  UploadPlanTreeTypes

export interface UploadPlan {
  baseTableName: string,
  uploadable: UploadPlanUploadable
}

export type FalsyUploadPlan = UploadPlan | false;


const excludeUnknownMatchingOptions = (
  matchingOptions: Exclude<UploadPlanUploadTableField,string>,
)=>Object.fromEntries(
  Object.entries(defaultLineOptions).map(([optionName, defaultValue])=>
    [
      optionName,
      optionName in matchingOptions ?
        //@ts-ignore
        matchingOptions[optionName] :
        defaultValue
    ]
  )
) as Exclude<UploadPlanUploadTableField,string>;


const uploadPlanProcessingFunctions = (
  headers: string[],
  mustMatchPreferences: Record<string, boolean>,
  mappingPath: string[],
): Readonly<Record<string, (
  [key, value]: [string, any],
) => [key: string, value: unknown]>> => (
  {
    wbcols: (
      [key, value]: [string, string | UploadPlanUploadTableField],
    ): [key: string, value: object] => [
      key,
      {
        [
          headers.indexOf(
            typeof value === 'string' ?
              value :
              value.column
          ) === -1 ?
            'newColumn' :
            'existingHeader'
          ]: typeof value === 'string' ?
            {
              [value]: defaultLineOptions,
            } :
            {
              [value.column]: excludeUnknownMatchingOptions(value)
            },
      },
    ],
    static: ([key, value]: [string, string]): [key: string, value: object] => [
      key,
      {newStaticColumn: value},
    ],
    toOne: (
      [tableName, value]: [string, UploadPlanUploadable],
    ): [key: string, value: object] => [
      tableName,
      handleUploadable(
        value,
        headers,
        mustMatchPreferences,
        [...mappingPath, tableName],
      ),
    ],
    toMany: (
      [tableName, mappings]: [string, object],
    ): [key: string, value: object] => [
      tableName,
      Object.fromEntries(
        Object.values(
          mappings,
        ).map((mapping, index) =>
          [
            formatReferenceItem(index + 1),
            handleUploadTableTable(
              mapping,
              headers,
              mustMatchPreferences,
              [...mappingPath, tableName],
            ),
          ],
        ),
      ),
    ],
  }
) as const;

const handleTreeRankFields = (
  treeRankFields: UploadPlanUploadTableFields,
  headers: string[],
) => Object.fromEntries(
  Object.entries(treeRankFields).map(
    ([fieldName, headerName]) =>
      uploadPlanProcessingFunctions(
        headers, {}, [],
      ).wbcols([fieldName, headerName]),
  ),
);

const handleTreeRecord = (
  uploadPlan: UploadPlanTreeRecord,
  headers: string[],
) =>
  Object.fromEntries(
    Object.entries((
      (
        uploadPlan
      ).ranks
    )).map(([
        rankName,
        rankData,
      ]) =>
        [
          formatTreeRank(rankName),
          handleTreeRankFields(
            typeof rankData === 'string' ?
              {
                name: rankData,
              } :
              rankData.treeNodeCols,
            headers,
          ),
        ],
    ),
  );

function handleTreeRecordTypes(
  uploadPlan: UploadPlanTreeTypes,
  headers: string[],
  mustMatchPreferences: Record<string, boolean>,
  mappingPath: string[],
) {

  if ('mustMatchTreeRecord' in uploadPlan) {
    const tableName = getMappingLineData({
      baseTableName: mappingPath[0],
      mappingPath: mappingPath.slice(1),
      iterate: false,
      customSelectType: 'OPENED_LIST',
    })[0].tableName;
    mustMatchPreferences[tableName || mappingPath.slice(-1)[0]] = true;
  }

  return handleTreeRecord(
    Object.values(uploadPlan)[0],
    headers,
  );

}


const handleUploadTableTable = (
  uploadPlan: UploadPlanUploadTableTable,
  headers: string[],
  mustMatchPreferences: Record<string, boolean>,
  mappingPath: string[],
) =>
  Object.fromEntries(Object.entries(uploadPlan).reduce(
    // @ts-ignore
    (
      results,
      [
        planNodeName,
        planNodeData,
      ]: [
        UploadPlanFieldGroupTypes,
        UploadPlanTableGroup<UploadPlanFieldGroupTypes>
      ],
    ) =>
      [
        ...results,
        ...Object.entries(planNodeData).map(
          uploadPlanProcessingFunctions(
            headers,
            mustMatchPreferences,
            mappingPath,
          )[planNodeName],
        ),
      ],
    [],
  ));

function handleUploadableTypes(
  uploadPlan: UploadPlanUploadtableTypes,
  headers: string[],
  mustMatchPreferences: Record<string, boolean>,
  mappingPath: string[],
) {

  if ('mustMatchTable' in uploadPlan) {
    const tableName = getMappingLineData({
      baseTableName: mappingPath[0],
      mappingPath: mappingPath.slice(1),
      iterate: false,
      customSelectType: 'OPENED_LIST',
    })[0].tableName;
    mustMatchPreferences[tableName || mappingPath.slice(-1)[0]] = true;
  }

  return handleUploadTableTable(
    Object.values(uploadPlan)[0],
    headers,
    mustMatchPreferences,
    mappingPath,
  );

}

const handleUploadable = (
  uploadPlan: UploadPlanUploadable,
  headers: string[],
  mustMatchPreferences: Record<string, boolean>,
  mappingPath: string[],
): MappingsTree =>
  'treeRecord' in uploadPlan || 'mustMatchTreeRecord' in uploadPlan ?
    handleTreeRecordTypes(
      uploadPlan,
      headers,
      mustMatchPreferences,
      mappingPath,
    ) :
    handleUploadableTypes(
      uploadPlan,
      headers,
      mustMatchPreferences,
      mappingPath,
    );

/*
* Converts upload plan to mappings tree
* Inverse of mappingsTreeToUploadPlan
* */
export function uploadPlanToMappingsTree(
  headers: string[],
  uploadPlan: UploadPlan,
): {
  baseTableName: string,
  mappingsTree: MappingsTree,
  mustMatchPreferences: Record<string, boolean>
} {

  if (typeof uploadPlan.baseTableName === 'undefined')
    throw new Error('Upload plan should contain `baseTableName`'
      + ' as a root node');

  const mustMatchPreferences: Record<string, boolean> = {};

  return {
    baseTableName: uploadPlan.baseTableName,
    mappingsTree: handleUploadable(
      uploadPlan.uploadable,
      headers,
      mustMatchPreferences,
      [uploadPlan.baseTableName],
    ),
    mustMatchPreferences,
  };
}

export function uploadPlanStringToObject(
  uploadPlanString: string,
): FalsyUploadPlan {
  let uploadPlan: FalsyUploadPlan;

  try {
    uploadPlan = JSON.parse(uploadPlanString) as UploadPlan;
  }
  catch (exception) {

    if (!(
      exception instanceof SyntaxError
    ))//only catch JSON parse errors
      throw exception;

    uploadPlan = false;

  }

  if (
    typeof uploadPlan !== 'object' ||
    uploadPlan === null ||
    typeof uploadPlan['baseTableName'] === 'undefined'
  )
    return false;
  else
    return uploadPlan;
}


//TODO: make these functions type safe

interface UploadPlanNode
  extends Record<string, string | boolean | UploadPlanNode> {
}

function mappingsTreeToUploadPlanTable(
  tableData: object,
  tableName: string | undefined,
  mustMatchPreferences: Record<string, boolean>,
  wrapIt = true,
  isRoot = false,
) {

  if (typeof tableName !== 'undefined' && tableIsTree(tableName))
    return mappingsTreeToUploadTable(
      tableData as MappingsTree,
      tableName,
      mustMatchPreferences,
    );

  let tablePlan: {
    wbcols: UploadPlanNode,
    static: UploadPlanNode,
    toOne: UploadPlanNode,
    toMany?: UploadPlanNode
  } = {
    wbcols: {},
    static: {},
    toOne: {},
  };

  if (wrapIt)
    tablePlan.toMany = {};

  let isToMany = false;

  tablePlan = Object.entries(
    tableData,
  ).reduce((
    originalTablePlan,
    [
      fieldName,
      fieldData,
    ],
  ) => {

    let tablePlan = originalTablePlan;

    if (valueIsReferenceItem(fieldName)) {
      if (!isToMany) {
        isToMany = true;
        //@ts-ignore
        tablePlan = [];
      }

      //@ts-ignore
      tablePlan.push(
        mappingsTreeToUploadPlanTable(
          fieldData,
          tableName,
          mustMatchPreferences,
          false,
        ),
      );

    }
    else if (valueIsTreeRank(fieldName))
      //@ts-ignore
      tablePlan = mappingsTreeToUploadPlanTable(
        tableData,
        tableName,
        mustMatchPreferences,
        false,
      );

    else if (
      typeof dataModelStorage.tables[
      tableName || ''
        ]?.fields[fieldName] !== 'undefined' &&
      typeof tablePlan !== 'undefined'
    ) {

      const field = dataModelStorage.tables[
      tableName || ''
        ]?.fields[fieldName];

      if (field.isRelationship)
        handleRelationshipField(
          fieldData,
          field,
          fieldName,
          tablePlan,
          mustMatchPreferences,
        );
      else
        //@ts-ignore
        tablePlan[
          Object.entries(
            fieldData,
          )[0][0] === 'newStaticColumn' ?
            'static' :
            'wbcols'
          ][fieldName] = extractHeaderNameFromHeaderStructure(
          fieldData,
        );
    }


    return tablePlan;

  }, tablePlan);


  if (Array.isArray(tablePlan) || !wrapIt)
    return tablePlan;

  if (valueIsReferenceItem(Object.keys(tableData)[0]))
    return tablePlan;

  return {
    [
      !isRoot && mustMatchPreferences[tableName || ''] ?
        'mustMatchTable' :
        'uploadTable'
      ]: tablePlan,
  };

}

function handleRelationshipField(
  fieldData: object,
  field: DataModelFieldWritable,
  fieldName: string,
  tablePlan: {
    wbcols: UploadPlanNode,
    static: UploadPlanNode,
    toOne: UploadPlanNode,
    toMany?: UploadPlanNode | undefined
  },
  mustMatchPreferences: Record<string, boolean>,
) {
  const mappingTable = field.tableName;
  if (typeof mappingTable === 'undefined')
    throw new Error('Mapping Table is not defined');

  const isToOne =
    field.type === 'one-to-one' ||
    field.type === 'many-to-one';

  if (
    isToOne &&
    typeof tablePlan.toOne[fieldName] === 'undefined'
  )
    tablePlan.toOne[fieldName] =
      mappingsTreeToUploadPlanTable(
        fieldData,
        mappingTable,
        mustMatchPreferences,
      ) as UploadPlanNode;

  else {
    tablePlan.toMany ??= {};
    tablePlan.toMany[fieldName] ??=
      mappingsTreeToUploadPlanTable(
        fieldData,
        mappingTable,
        mustMatchPreferences,
        false,
      ) as UploadPlanNode;
  }
}


export const extractHeaderNameFromHeaderStructure = (
  headerStructure: MappingsTreeNode,
): UploadPlanUploadTableField => Object.entries(
  Object.values(
    headerStructure,
  )[0],
).map(([headerName, headerOptions]) =>
  JSON.stringify(headerOptions) === JSON.stringify(defaultLineOptions) ?
    headerName :
    {
      ...defaultLineOptions,
      column: headerName,
      ...headerOptions,
    },
)[0];

const rankMappedFieldsToTreeRecordRanks = (
  rankMappedFields: Record<string, MappingsTreeNode>,
): UploadPlanUploadTableFields => Object.fromEntries(
  Object.entries(rankMappedFields).map(([
    fieldName, headerMappingStructure,
  ]) => [
    fieldName,
    extractHeaderNameFromHeaderStructure(
      headerMappingStructure,
    ),
  ]),
);

const mappingsTreeToUploadPlanTree = (
  mappingsTree: MappingsTree,
): UploadPlanTreeRecordRanks => Object.fromEntries(
  Object.entries(mappingsTree).map(([
    fullRankName, rankMappedFields,
  ]) => [
    getNameFromTreeRankName(fullRankName),
    {
      treeNodeCols: rankMappedFieldsToTreeRecordRanks(
        rankMappedFields as Record<string,
          MappingsTreeNode>,
      ),
    },
  ]),
);

/*const mappingsTreeToUploadTableTable = (
  mappingsTree: MappingsTree,
  tableName: string,
): UploadPlanUploadTableTable => (
  {}
);*/

const mappingsTreeToUploadTable = (
  mappingsTree: MappingsTree,
  tableName: string,
  mustMatchPreferences: Record<string, boolean>,
  isRoot = false,
): UploadPlanUploadable =>
  tableIsTree(tableName) ?
    {
      [
        (
          tableName in mustMatchPreferences
        ) ?
          'mustMatchTreeRecord' :
          'treeRecord'
        ]: {
        ranks: mappingsTreeToUploadPlanTree(
          mappingsTree,
        ),
      },
    } as UploadPlanTreeTypes :
    mappingsTreeToUploadPlanTable(
      mappingsTree,
      tableName,
      mustMatchPreferences,
      true,
      isRoot,
    ) as UploadPlanUploadable;

/*
* Converts mappings tree to upload plan
* Inverse of uploadPlanToMappingsTree
* */
export const mappingsTreeToUploadPlan = (
  baseTableName: string,
  mappingsTree: MappingsTree,
  mustMatchPreferences: Record<string, boolean>,
): UploadPlan => (
  {
    baseTableName,
    uploadable: mappingsTreeToUploadTable(
      mappingsTree,
      baseTableName,
      mustMatchPreferences,
      true,
    ),
  }
);