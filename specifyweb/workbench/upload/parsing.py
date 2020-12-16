
import logging
import math
import re

from typing import Dict, Any, Optional, List, NamedTuple, Tuple, Union
from dateparser import DateDataParser # type: ignore

from django.core.exceptions import ObjectDoesNotExist

from specifyweb.specify import models
from specifyweb.specify.datamodel import datamodel, Table
from specifyweb.specify.uiformatters import get_uiformatter, FormatMismatch

from .uploadable import Filter, Row
from .validation_schema import CellIssue

logger = logging.getLogger(__name__)

class PicklistAddition(NamedTuple):
    picklist: Any
    caption: str
    value: str

class ParseFailure(NamedTuple):
    message: str

class ParseResult(NamedTuple):
    filter_on: Filter
    upload: Dict[str, Any]
    add_to_picklist: Optional[PicklistAddition]

def filter_and_upload(f: Filter) -> ParseResult:
    return ParseResult(f, f, None)

def parse_many(collection, tablename: str, mapping: Dict[str, str], row: Row) -> Tuple[List[ParseResult], List[CellIssue]]:
    results = [
        (caption, parse_value(collection, tablename, fieldname, row[caption], caption))
        for fieldname, caption in mapping.items()
    ]
    return (
        [r for _, r in results if isinstance(r, ParseResult)],
        [CellIssue(c, r.message) for c, r in results if isinstance(r, ParseFailure)]
    )

def parse_value(collection, tablename: str, fieldname: str, value: str, caption: str) -> Union[ParseResult, ParseFailure]:
    value = value.strip()
    schema_items = getattr(models, 'Splocalecontaineritem').objects.filter(
        container__discipline=collection.discipline,
        container__schematype=0,
        container__name=tablename.lower(),
        name=fieldname.lower())

    if value == "":
        if schema_items and schema_items[0].isrequired:
            return ParseFailure("field is required")
        return ParseResult({fieldname: None}, {}, None)

    if tablename.lower() == 'agent' and fieldname.lower() == 'agenttype':
        return parse_agenttype(value)

    if schema_items and schema_items[0].picklistname:
        result = parse_with_picklist(collection, schema_items[0].picklistname, fieldname, value, caption)
        if result is not None:
            return result

    uiformatter = get_uiformatter(collection, tablename, fieldname)
    if uiformatter:
        try:
            canonicalized = uiformatter.canonicalize(uiformatter.parse(value))
        except FormatMismatch as e:
            return ParseFailure(e.args[0])
        return filter_and_upload({fieldname: canonicalized})

    table = datamodel.get_table_strict(tablename)
    field = table.get_field_strict(fieldname)

    if field.type == "java.lang.Boolean":
        return parse_boolean(fieldname, value)

    if is_latlong(table, field):
        return parse_latlong(field, value)

    if field.is_temporal():
        return parse_date(table, fieldname, value)

    return filter_and_upload({fieldname: value})

def parse_boolean(fieldname: str, value: str) -> Union[ParseResult, ParseFailure]:
    if value.lower() in ["yes", "true"]:
        result = True
    elif value.lower() in ["no", "false"]:
        result = False
    else:
        return ParseFailure(f"value {value} not resolvable to True or False")

    return filter_and_upload({fieldname: result})

def parse_with_picklist(collection, picklist_name: str, fieldname: str, value: str, caption: str) -> Union[ParseResult, ParseFailure, None]:
    picklist = getattr(models, 'Picklist').objects.get(name=picklist_name, collection=collection)
    if picklist.type == 0: # items from picklistitems table
        try:
            item = picklist.picklistitems.get(title=value)
            return filter_and_upload({fieldname: item.value})
        except ObjectDoesNotExist:
            if picklist.readonly:
                return ParseFailure("value {} not in picklist {}".format(value, picklist.name))
            else:
                return filter_and_upload({fieldname: value})._replace(
                    add_to_picklist=PicklistAddition(picklist=picklist, caption=caption, value=value)
                )
            return filter_and_upload({fieldname: value})

    elif picklist.type == 1: # items from rows in some table
        # we ignore this type of picklist because it is primarily used to choose many-to-one's on forms
        # so it is not expected to appear on actual fields
        return None

    elif picklist.type == 2: # items from a field in some table
        # this picklist type is rarely used and seems mostly for convenience on forms to allow
        # quickly selecting existing values from other rows in the same table. e.g. moleculeType
        return None

    else:
        raise NotImplementedError("unknown picklist type {}".format(picklist.type))

def parse_agenttype(value: str) -> Union[ParseResult, ParseFailure]:
    agenttypes = ['Organization', 'Person', 'Other', 'Group']

    value = value.capitalize()
    try:
        agenttype = agenttypes.index(value)
    except ValueError:
        return ParseFailure("bad agent type: {}. Expected one of {}".format(value, agenttypes))
    return filter_and_upload({'agenttype': agenttype})

def parse_date(table: Table, fieldname: str, value: str) -> Union[ParseResult, ParseFailure]:
    precision_field = table.get_field(fieldname + 'precision')
    parsed = DateDataParser(
        settings={
            'PREFER_DAY_OF_MONTH': 'first',
            'PREFER_DATES_FROM': 'past',
            'STRICT_PARSING': precision_field is None,
        },
    ).get_date_data(value, date_formats=['%d/%m/%Y', '00/%m/%Y'])

    if parsed['date_obj'] is None:
        return ParseFailure("bad date value: {}".format(value))

    if precision_field is None:
        if parsed['period'] == 'day':
            return filter_and_upload({fieldname: parsed['date_obj']})
        else:
            return ParseFailure("bad date value: {}".format(value))
    else:
        prec = parsed['period']
        date = parsed['date_obj']
        if prec == 'day':
            return filter_and_upload({fieldname: date, precision_field.name.lower(): 0})
        elif prec == 'month':
            return filter_and_upload({fieldname: date.replace(day=1), precision_field.name.lower(): 1})
        elif prec == 'year':
            return filter_and_upload({fieldname: date.replace(day=1, month=1), precision_field.name.lower(): 2})
        else:
            return ParseFailure('expected date precision to be day month or year. got: {}'.format(prec))


def parse_string(value: str) -> Optional[str]:
    result = value.strip()
    if result == "":
        return None
    return result

def is_latlong(table, field) -> bool:
    return table.name == 'Locality' \
        and field.name in ('latitude1', 'longitude1', 'latitude2', 'longitude2')

def parse_latlong(field, value: str) -> Union[ParseResult, ParseFailure]:
    parsed = parse_coord(value)

    if parsed is None:
        return ParseFailure('bad latitude or longitude value: {}'.format(value))

    coord, unit = parsed
    if field.name.startswith('lat') and abs(coord) >= 90:
        return ParseFailure(f'latitude absolute value must be less than 90 degrees: {value}')

    if field.name.startswith('long') and abs(coord) >= 180:
        return ParseFailure(f'longitude absolute value must be less than 180 degrees: {value}')

    text_filter = {field.name.replace('itude', '') + 'text': parse_string(value)}
    return ParseResult(
        text_filter,
        {field.name: coord, 'originallatlongunit': unit, **text_filter},
        None
    )


def parse_coord(value: str) -> Optional[Tuple[float, int]]:
    for p in LATLONG_PARSER_DEFS:
        match = re.compile(p.regex, re.I).match(value)
        if match and match.group(1):
            # relies on signed zeros in floats
            # see https://docs.python.org/3/library/math.html#math.copysign
            comps = [float(match.group(i)) for i in p.comp_groups]
            result, divisor = 0.0, 1
            for comp in comps:
                result += abs(comp) / divisor
                divisor *= 60
            result = math.copysign(result, comps[0])
            if match.group(p.dir_group).lower() in ("s", "w"):
                result = -result
            return (result, p.unit)
    return None

class LatLongParserDef(NamedTuple):
    regex: str
    comp_groups: List[int]
    dir_group: int
    unit: int

LATLONG_PARSER_DEFS = [
    LatLongParserDef(
        r'^(-?\d{0,3}(\.\d*)?)[^\d\.nsew]*([nsew]?)$',
        [1],
        3,
        0
    ),

    LatLongParserDef(
        r'^(-?\d{1,3})[^\d\.]+(\d{0,2}(\.\d*)?)[^\d\.nsew]*([nsew]?)$',
        [1, 2],
        4,
        2
    ),

    LatLongParserDef(
        r'^(-?\d{1,3})[^\d\.]+(\d{1,2})[^\d\.]+(\d{0,2}(\.\d*)?)[^\d\.nsew]*([nsew]?)$',
        [1, 2, 3],
        5,
        1
    ),
]
