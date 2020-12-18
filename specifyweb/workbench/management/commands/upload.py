import csv
import json
from jsonschema import validate # type: ignore
from optparse import make_option

from django.core.management.base import BaseCommand, CommandError
from django.db import transaction

from specifyweb.specify import models

from specifyweb.workbench.upload.upload import do_upload_wb
from specifyweb.workbench.upload.upload_plan_schema import schema, parse_plan

Collection = getattr(models, 'Collection')
Workbench = getattr(models, 'Workbench')

class NoCommit(Exception):
    pass


class Command(BaseCommand):
    help = 'Upload a dataset to the database.'

    def add_arguments(self, parser) -> None:
        parser.add_argument('collection_id', type=int)
        parser.add_argument('dataset_id', type=int)

        parser.add_argument(
            '--commit',
            action='store_true',
            dest='commit',
            default=False,
            help='Commit the changes to the database.'
        )

    def handle(self, *args, **options) -> None:
        specify_collection = Collection.objects.get(id=options['collection_id'])
        wb = Workbench.objects.get(id=options['dataset_id'])
        result = do_upload_wb(specify_collection, wb, not options['commit'])
        self.stdout.write(json.dumps([r.to_json() for r in result], indent=2))