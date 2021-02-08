from ..upload_table import UploadTable, ScopedUploadTable
from ..tomany import ToManyRecord
from ..treerecord import TreeRecord

json = dict(
    baseTableName = 'Collectionobject',
    uploadable = { 'uploadTable': dict(
        wbcols = {
            'catalognumber' : "BMSM No.",
        },
        static = {},
        toMany = {
            'determinations': [
                dict(
                    wbcols = {
                        'determineddate': 'ID Date',
                    },
                    static = {
                        'iscurrent': True,
                    },
                    toOne = {
                        'determiner': { 'uploadTable': dict(
                            wbcols = {
                                'title': 'Determiner 1 Title',
                                'firstname': 'Determiner 1 First Name',
                                'middleinitial': 'Determiner 1 Middle Initial',
                                'lastname': 'Determiner 1 Last Name',
                            },
                            static = {
                                'agenttype': 1
                            },
                            toOne = {},
                            toMany = {},
                        )},
                        'taxon': { 'treeRecord': dict(
                            ranks = {
                                'Class': 'Class',
                                'Superfamily': 'Superfamily',
                                'Family': 'Family',
                                'Genus': 'Genus',
                                'Subgenus': 'Subgenus',
                                'Species': dict(
                                    treeNodeCols = {
                                        'name': 'Species',
                                        'author': 'Species Author',
                                    },
                                ),
                                'Subspecies': dict(
                                    treeNodeCols = {
                                        'name': 'Subspecies',
                                        'author': 'Subspecies Author',
                                    },
                                ),
                            }
                        )}
                    },
                ),
            ],
        },
        toOne = {
            'collectingevent': { 'uploadTable': dict(
                wbcols = {
                    'enddate' : 'End Date Collected',
                    'startdate' : 'Start Date Collected',
                    'stationfieldnumber' : 'Station No.',
                },
                static = {},
                toOne = {
                    'locality': { 'uploadTable': dict(
                        wbcols = {
                            'localityname': 'Site',
                            'latitude1': 'Latitude1',
                            'longitude1': 'Longitude1',
                        },
                        static = {'srclatlongunit': 0},
                        toOne = {
                            'geography': { 'treeRecord': dict(
                                ranks = {
                                    'Continent': 'Continent/Ocean' ,
                                    'Country': 'Country',
                                    'State': 'State/Prov/Pref',
                                    'County': 'Region',
                                }
                            )},
                        },
                        toMany = {},
                    )}
                },
                toMany = {
                    'collectors': [
                        dict(
                            wbcols = {},
                            static = {'isprimary': True, 'ordernumber': 0},
                            toOne = {
                                'agent': { 'uploadTable': dict(
                                    wbcols = {
                                        'title'          : 'Collector 1 Title',
                                        'firstname'     : 'Collector 1 First Name',
                                        'middleinitial' : 'Collector 1 Middle Initial',
                                        'lastname'      : 'Collector 1 Last Name',
                                    },
                                    static = {
                                        'agenttype': 1
                                    },
                                    toOne = {},
                                    toMany = {},
                                )}
                            }
                        ),
                        dict(
                            wbcols = {},
                            static = {'isprimary': False, 'ordernumber': 1},
                            toOne = {
                                'agent': { 'uploadTable': dict(
                                    wbcols = {
                                        'title'          : 'Collector 2 Title',
                                        'firstname'     : 'Collector 2 First Name',
                                        'middleinitial' : 'Collector 2 Middle Initial',
                                        'lastname'      : 'Collector 2 Last name',
                                    },
                                    static = {
                                        'agenttype': 1
                                    },
                                    toOne = {},
                                    toMany = {},
                                )}
                            }
                        ),
                    ]
                }
            )}
        }
    )}
)

def with_scoping(collection) -> ScopedUploadTable:
    return UploadTable(
        name = 'Collectionobject',
        wbcols = {
            'catalognumber' : "BMSM No.",
        },
        static = {},
        toMany = {
            'determinations': [
                ToManyRecord(
                    name = 'Determination',
                    wbcols = {
                        'determineddate': 'ID Date',
                    },
                    static = {
                        'iscurrent': True,
                    },
                    toOne = {
                        'determiner': UploadTable(
                            name = 'Agent',
                            wbcols = {
                                'title': 'Determiner 1 Title',
                                'firstname': 'Determiner 1 First Name',
                                'middleinitial': 'Determiner 1 Middle Initial',
                                'lastname': 'Determiner 1 Last Name',
                            },
                            static = {'agenttype': 1},
                            toOne = {},
                            toMany = {},
                        ),
                        'taxon': TreeRecord(
                            name = 'Taxon',
                            ranks = {
                                'Class': {'name': 'Class'},
                                'Superfamily': {'name': 'Superfamily'},
                                'Family': {'name': 'Family'},
                                'Genus': {'name': 'Genus'},
                                'Subgenus': {'name': 'Subgenus'},
                                'Species': {'name': 'Species', 'author': 'Species Author'},
                                'Subspecies': {'name': 'Subspecies', 'author': 'Subspecies Author'},
                            }
                        )
                    },
                ),
            ],
        },
        toOne = {
            'collectingevent': UploadTable(
                name = 'Collectingevent',
                wbcols = {
                    'enddate' : 'End Date Collected',
                    'startdate' : 'Start Date Collected',
                    'stationfieldnumber' : 'Station No.',
                },
                static = {},
                toOne = {
                    'locality': UploadTable(
                        name = 'Locality',
                        wbcols = {
                            'localityname': 'Site',
                            'latitude1': 'Latitude1',
                            'longitude1': 'Longitude1',
                        },
                        static = {'srclatlongunit': 0},
                        toOne = {
                            'geography': TreeRecord(
                                name = 'Geography',
                                ranks = {
                                    'Continent': {'name': 'Continent/Ocean'},
                                    'Country': {'name': 'Country'},
                                    'State': {'name': 'State/Prov/Pref'},
                                    'County': {'name': 'Region'},
                                }
                            ),
                        },
                        toMany = {},
                    )
                },
                toMany = {
                    'collectors': [
                        ToManyRecord(
                            name = 'Collector',
                            wbcols = {},
                            static = {'isprimary': True, 'ordernumber': 0},
                            toOne = {
                                'agent': UploadTable(
                                    name = 'Agent',
                                    wbcols = {
                                        'title'          : 'Collector 1 Title',
                                        'firstname'     : 'Collector 1 First Name',
                                        'middleinitial' : 'Collector 1 Middle Initial',
                                        'lastname'      : 'Collector 1 Last Name',
                                    },
                                    static = {'agenttype': 1},
                                    toOne = {},
                                    toMany = {},
                                )
                            }
                        ),
                        ToManyRecord(
                            name = 'Collector',
                            wbcols = {},
                            static = {'isprimary': False, 'ordernumber': 1},
                            toOne = {
                                'agent': UploadTable(
                                    name = 'Agent',
                                    wbcols = {
                                        'title'          : 'Collector 2 Title',
                                        'firstname'     : 'Collector 2 First Name',
                                        'middleinitial' : 'Collector 2 Middle Initial',
                                        'lastname'      : 'Collector 2 Last name',
                                    },
                                    static = {'agenttype': 1},
                                    toOne = {},
                                    toMany = {},
                                )
                            }
                        ),
                    ]
                }
            ),
        },
    ).apply_scoping(collection)
