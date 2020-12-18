"use strict";
require ('../css/workbench.css');

const $        = require('jquery');
const _        = require('underscore');
const Backbone = require('./backbone.js');
const Q        = require('q');
const Handsontable = require('handsontable');
const Papa = require('papaparse');

const schema = require('./schema.js');
const app = require('./specifyapp.js');
const WBName = require('./wbname.js');
const navigation = require('./navigation.js');
const WBUploadedView = require('./wbuploadedview.js');
const WBStatus = require('./wbstatus.js');

const template = require('./templates/wbview.html');

const wb_upload_helper = require('./wb_upload/external_helper.ts');
const latlongutils = require('./latlongutils.js');

const L = require('leaflet');
require('leaflet/dist/leaflet.css');
/* This code is needed to properly load the images in the Leaflet CSS */
delete L.Icon.Default.prototype._getIconUrl;
L.Icon.Default.mergeOptions({
  iconRetinaUrl: require('leaflet/dist/images/marker-icon-2x.png'),
  iconUrl: require('leaflet/dist/images/marker-icon.png'),
  shadowUrl: require('leaflet/dist/images/marker-shadow.png'),
});

const WBView = Backbone.View.extend({
    __name__: "WbForm",
    className: "wbs-form",
    events: {
        'click .wb-upload': 'upload',
        'click .wb-validate': 'upload',
        'click .wb-plan': 'openPlan',
        'click .wb-show-plan': 'showPlan',
        'click .wb-delete': 'delete',
        'click .wb-save': 'saveClicked',
        'click .wb-export': 'export',
        'click .wb-toggle-highlights': 'toggleHighlights',
        'click .wb-cell_navigation': 'navigateCells',
        'click .wb-search-button': 'searchCells',
        'click .wb-replace-button': 'replaceCells',
        'click .wb-show-toolbelt': 'toggleToolbelt',
        'click .wb-geolocate': 'showGeoLocate',
        'click .wb-leafletmap': 'showLeafletMap',
        'click .wb-convert-coordinates': 'showCoordinateConversion',
    },
    initialize({wb, data, initialStatus}) {
        this.wb = wb;
        this.data = data;
        this.initialStatus = initialStatus;
        this.highlightsOn = false;
        this.cellInfo = [];
        this.rowValidationRequests = {};
        this.search_query = null;
    },
    render() {
        const mappingsPromise = Q(this.wb.rget('workbenchtemplate.workbenchtemplatemappingitems'))
                  .then(mappings => _.sortBy(mappings.models, mapping => mapping.get('viewOrder')));

        const colHeaders = mappingsPromise.then(mappings => _.invoke(mappings, 'get', 'caption'));
        const columns = mappingsPromise.then(mappings => _.map(mappings, (m, i) => ({data: i+1})));

        this.$el.append(template());
        new WBName({wb: this.wb, el: this.$('.wb-name')}).render();

        Q.all([colHeaders, columns]).spread(this.setupHOT.bind(this)).done();

        if (this.initialStatus) this.openStatus();
        return this;
    },
    setupHOT(colHeaders, columns) {
        if (this.data.length < 1)
            this.data.push(Array(columns.length + 1).fill(null));

        //initialize Handsontable
        const onChanged = this.spreadSheetChanged.bind(this);

        this.colHeaders = colHeaders;
        this.find_locality_columns();
        this.hot = new Handsontable(this.$('.wb-spreadsheet')[0], {
            height: this.calcHeight(),
            data: this.data,
            cells: this.defineCell.bind(this, columns.length),
            colHeaders: colHeaders,
            columns: columns,
            minSpareRows: 0,
            comments: true,
            rowHeaders: true,
            manualColumnResize: true,
            outsideClickDeselects: false,
            columnSorting: true,
            sortIndicator: true,
            search: {
                searchResultClass: 'wb-search-match-cell',
            },
            contextMenu: {
                items: {
                    'row_above': 'row_above',
                    'row_below': 'row_below',
                    'remove_row': 'remove_row',
                    'separator_1': '---------',
                    'fill_down_with_increment': {
                        name: 'Fill down with increment',
                        disabled: function(){
                            const selections = this.getSelected();

                            return (
                                    typeof selections === "undefined" ||
                                    selections.every(selection=>
                                        selection[0]===selection[2]
                                    )
                                );
                        },
                        callback: (_, selections) =>
                            selections.map(selection=>{

                                const start_column = selection.start.col;
                                const end_column = selection.end.col;

                                // if selection spans over several columns, run fill down for each individually
                                for(let current_column=start_column; current_column<=end_column; current_column++)
                                    this.fillDownCells({
                                        start_row: selection.start.row,
                                        end_row: selection.end.row,
                                        col: current_column,
                                    });
                            }) && this.hot.deselectCell()
                    },
                    'separator_2': '---------',
                    'undo': 'undo',
                    'redo': 'redo',
                }
            },
            stretchH: 'all',
            afterCreateRow: (index, amount) => { this.fixCreatedRows(index, amount); onChanged(); },
            afterRemoveRow: () => { if (this.hot.countRows() === 0) { this.hot.alter('insert_row', 0); } onChanged();},
            afterSelection: (r, c) => this.currentPos = [r,c],
            afterChange: (change, source) => source === 'loadData' || onChanged(change),
        });

        $(window).resize(this.resize.bind(this));

        this.getResults();
    },
    getResults() {
        Q($.get(`/api/workbench/results/${this.wb.id}/`))
            .done(results => this.parseResults(results));
    },
    initCellInfo(row, col) {
        const cols = this.hot.countCols();
        if(typeof this.cellInfo[row*cols + col] === "undefined") {
            this.cellInfo[row*cols + col] = {isNew: false, issues: [], matchesSearch: false};
        }
    },
    parseResults(results) {
        const cols = this.hot.countCols();
        const headerToCol = {};
        for (let i = 0; i < cols; i++) {
            headerToCol[this.hot.getColHeader(i)] = i;
        }

        this.cellInfo = [];
        results.forEach((result, row) => {
            this.parseRowValidationResult(row, result);
        });

        this.updateCellInfos();
    },
    updateCellInfos() {
        const cellCounts = {
            new_cells: this.cellInfo.reduce((count, info) => count + (info.isNew ? 1 : 0), 0),
            invalid_cells: this.cellInfo.reduce((count, info) => count + (info.issues.length ? 1 : 0), 0),
            search_results: this.cellInfo.reduce((count, info) => count + (info.matchesSearch ? 1 : 0), 0),
        };

        //update navigation information
        Object.values(document.getElementsByClassName('wb-navigation_total')).forEach(navigation_total_element => {
            const navigation_type = navigation_total_element.parentElement.getAttribute('data-navigation_type');
            navigation_total_element.innerText = cellCounts[navigation_type];
        });

        this.hot.render();
    },
    parseRowValidationResult(row, result) {
        const cols = this.hot.countCols();
        const headerToCol = {};
        for (let i = 0; i < cols; i++) {
            headerToCol[this.hot.getColHeader(i)] = i;
        }

        for (let i = 0; i < cols; i++) {
            delete this.cellInfo[row*cols + i];
        }

        const add_error_message = (column_name, issue) => {
            const col = headerToCol[column_name];
            this.initCellInfo(row, col);
            const cellInfo = this.cellInfo[row*cols + col];

            const ucfirst_issue = issue[0].toUpperCase() + issue.slice(1);
            cellInfo.issues.push(ucfirst_issue);
        };

        if(result === null)
            return;

        result.tableIssues.forEach(table_issue => table_issue.columns.forEach(column_name => {
            add_error_message(column_name, table_issue.issue);
        }));

        result.cellIssues.forEach(cell_issue => {
            add_error_message(cell_issue.column, cell_issue.issue);
        });

        result.newRows.forEach(table => table.columns.forEach(column_name => {
            const col = headerToCol[column_name];
            this.initCellInfo(row, col);
            const cellInfo = this.cellInfo[row*cols + col];
            cellInfo.isNew = true;
        }));
    },
    defineCell(cols, row, col, prop) {
        let cell_data;
        try {
            cell_data = this.cellInfo[row*cols + col];
        } catch (e) {
        };

        return {
            comment: cell_data && {value: cell_data.issues.join('<br>')},
            renderer: function(instance, td, row, col, prop, value, cellProperties) {
                if(cell_data && cell_data.isNew)
                    td.classList.add('wb-no-match-cell');

                if(cell_data && cell_data.issues.length)
                    td.classList.add('wb-invalid-cell');

                Handsontable.renderers.TextRenderer.apply(null, arguments);
            }
        };
    },
    openPlan() {
        navigation.go(`/workbench-plan/${this.wb.id}/`);
    },
    showPlan() {
        this.wb.rget('workbenchtemplate').done(wbtemplate => {
            $('<div>').append($('<textarea cols="120" rows="50">').text(wbtemplate.get('remarks'))).dialog({
                title: "Upload plan",
                width: 'auto',
                modal: true,
                close() { $(this).remove(); },
                buttons: {
                    Save() {
                        wbtemplate.set('remarks', $('textarea', this).val());
                        wbtemplate.save();
                        $(this).dialog('close');
                    } ,
                    Close() { $(this).dialog('close'); }
                }
            });
        });
    },
    fixCreatedRows: function(index, amount) {
        // Handsontable doesn't insert the correct number of elements in newly
        // inserted rows. It inserts as many as there are columns, but there
        // should be an extra one at the begining representing the wb row id.
        for (let i = 0; i < amount; i++) {
            this.data[i + index] = Array(this.hot.countCols() + 1).fill(null);
        }
    },
    spreadSheetChanged(change) {
        this.$('.wb-upload, .wb-validate').prop('disabled', true);
        this.$('.wb-upload, .wb-match').prop('disabled', true);
        this.$('.wb-save').prop('disabled', false);
        navigation.addUnloadProtect(this, "The workbench has not been saved.");

        change && change.forEach(([row]) => {
            const rowData = this.hot.getDataAtRow(row);
            const data = Object.fromEntries(rowData.map((value, i) => [this.hot.getColHeader(i), value]));
            const req = this.rowValidationRequests[row] = $.post(`/api/workbench/validate_row/${this.wb.id}/`, data);
            req.done(result => this.gotRowValidationResult(row, req, result));
        });
    },
    gotRowValidationResult(row, req, result) {
        if (req === this.rowValidationRequests[row]) {
            this.parseRowValidationResult(row, result);
            this.updateCellInfos();
        }
    },
    resize: function() {
        this.hot && this.hot.updateSettings({height: this.calcHeight()});
        return true;
    },
    calcHeight: function() {
        return $(window).height() - this.$el.offset().top - 50;
    },
    saveClicked: function() {
        this.save().done();
    },
    save: function() {
        // clear validation
        this.cellInfo = [];
        this.hot.render();

        //show saving progress bar
        var dialog = $('<div><div class="progress-bar"></div></div>').dialog({
            title: 'Saving',
            modal: true,
            open: function(evt, ui) { $('.ui-dialog-titlebar-close', ui.dialog).hide(); },
            close: function() {$(this).remove();}
        });
        $('.progress-bar', dialog).progressbar({value: false});

        //send data
        return Q($.ajax('/api/workbench/rows/' + this.wb.id + '/', {
            data: JSON.stringify(this.data),
            error: this.checkDeletedFail.bind(this),
            type: "PUT"
        })).then(data => {
            this.data = data;
            this.hot.loadData(data);
            this.spreadSheetUpToDate();
        }).finally(() => dialog.dialog('close'));
    },
    checkDeletedFail(jqxhr) {
        if (jqxhr.status === 404) {
            this.$el.empty().append('Dataset was deleted by another session.');
            jqxhr.errorHandled = true;
        }
    },
    spreadSheetUpToDate: function() {
        this.$('.wb-upload, .wb-validate').prop('disabled', false);
        this.$('.wb-upload, .wb-match').prop('disabled', false);
        this.$('.wb-save').prop('disabled', true);
        navigation.removeUnloadProtect(this);
    },
    upload(evt) {
        const mode = $(evt.currentTarget).is('.wb-upload') ? "upload" : "validate";
        const openPlan = () => this.openPlan();
        this.wb.rget('workbenchtemplate.remarks').done(plan => {
            if (plan == null || plan.trim() === "") {
                $('<div>No plan has been defined for this dataset. Create one now?</div>').dialog({
                    title: "No Plan is defined.",
                    modal: true,
                    buttons: {
                        'Create': openPlan,
                        'Cancel': function() { $(this).dialog('close'); }
                    }
                });
            } else {
                $.post(`/api/workbench/${mode}/${this.wb.id}/`).fail(jqxhr => {
                    this.checkDeletedFail(jqxhr);
                }).done(() => {
                    this.openStatus(mode);
                });
            }
        });
    },
    openStatus(mode) {
        new WBStatus({wb: this.wb, status: this.initialStatus}).render().on('done', () => {
            if (mode === "upload") {
                this.trigger('refresh');
            } else {
                this.initialStatus = null;
                this.getResults();
            }
        });
    },
    showHighlights: function() {
        this.highlightsOn = true;
        this.hot.render();
    },
    removeHighlights: function() {
        this.highlightsOn = false;
        this.hot.render();
    },
    toggleHighlights: function() {
        if (this.highlightsOn) {
            this.removeHighlights();
            this.$('.wb-toggle-highlights').text('Show');
        } else {
            this.showHighlights();
            this.$('.wb-toggle-highlights').text('Hide');
        }
    },
    delete: function(e) {
        let dialog;
        const doDelete = () => {
            dialog.dialog('close');
            dialog = $('<div><div class="progress-bar"></div></div>').dialog({
                modal: true,
                title: "Deleting",
                close: function() { $(this).remove(); },
                open: function(evt, ui) { $('.ui-dialog-titlebar-close', ui.dialog).hide(); }
            });
            $('.progress-bar', dialog).progressbar({value: false});
            this.wb.destroy().done(() => {
                this.$el.empty().append('<p>Dataset deleted.</p>');
                dialog.dialog('close');
            }).fail(jqxhr => {
                this.checkDeletedFail(jqxhr);
                dialog.dialog('close');
            });
        };

        dialog = $('<div>Really delete?</div>').dialog({
            modal: true,
            title: "Confirm delete",
            close: function() { $(this).remove(); },
            buttons: {
                'Delete': doDelete,
                'Cancel': function() { $(this).dialog('close'); }
            }
        });
    },
    export: function(e) {
        const data = Papa.unparse({
            fields: this.hot.getColHeader(),
            data: this.data.map(row => row.slice(1))
        });
        const wbname = this.wb.get('name');
        const filename = wbname.match(/\.csv$/) ? wbname : wbname + '.csv';
        const blob = new Blob([data], {type: 'text/csv;charset=utf-8;'});
        const a = document.createElement('a');
        a.href = window.URL.createObjectURL(blob);
        a.setAttribute('download', filename);
        a.click();
    },
    navigateCells: function(e,match_current_cell=false){
        const button = e.target;
        const direction = button.getAttribute('data-navigation_direction');
        const button_parent = button.parentElement;
        const type = button_parent.getAttribute('data-navigation_type');

        const number_of_columns = this.hot.countCols();

        const selected_cell = this.hot.getSelectedLast();

        let current_position = 0;
        if(typeof selected_cell !== "undefined") {
            const [row, col] = selected_cell;
            current_position = row * number_of_columns + col;
        }

        const cellIsType = (info) => {
            switch(type) {
            case 'invalid_cells':
                return info.issues.length > 0;
            case 'new_cells':
                return info.isNew;
            case 'search_results':
                return info.matchesSearch;
            default:
                return false;
            }
        };

        let new_position = current_position;
        let found = false;
        for (;
             new_position >= 0 && new_position < this.cellInfo.length;
             new_position += direction === 'next' ? 1 : -1)
        {
            if (new_position === current_position && !match_current_cell) continue;

            const info = this.cellInfo[new_position];
            if (typeof info === "undefined") continue;
            found = cellIsType(info);
            if (found) break;
        }

        if (found) {
            const row = Math.floor(new_position / number_of_columns);
            const col = new_position - row * number_of_columns;
            this.hot.selectCell(row, col, row, col);

            const cell_relative_position = this.cellInfo.reduce((count, info, i) => count + (cellIsType(info) && i <= new_position ? 1 : 0), 0);
            const current_position_element = button_parent.getElementsByClassName('wb-navigation_position')[0];
            current_position_element.innerText = cell_relative_position;
        }
    },
    searchCells: function(e){
        const cols = this.hot.countCols();
        const button = e.target;
        const container = button.parentElement;
        const navigation_position_element = container.getElementsByClassName('wb-navigation_position')[0];
        const navigation_total_element = container.getElementsByClassName('wb-navigation_total')[0];
        const search_query_element = container.getElementsByClassName('wb-search_query')[0];
        const navigation_button = container.getElementsByClassName('wb-cell_navigation');
        const search_query = search_query_element.value;

        const searchPlugin = this.hot.getPlugin('search');
        const results = searchPlugin.query(search_query);
        this.search_query = search_query;

        this.cellInfo.forEach(cellInfo => {cellInfo.matchesSearch = false;});
        results.forEach(({row, col}) => {
            this.initCellInfo(row, col);
            this.cellInfo[row*cols + col].matchesSearch = true;
        });
        this.hot.render();

        navigation_total_element.innerText = results.length;
        navigation_position_element.innerText = 0;

        if(!this.navigateCells({target:navigation_button[0]},true))
            this.navigateCells({target:navigation_button[1]},true);

    },
    replaceCells: function(e){
        const cols = this.hot.countCols();
        const button = e.target;
        const container = button.parentElement;
        const replacement_value_element = container.getElementsByClassName('wb-replace_value')[0];
        const replacement_value = replacement_value_element.value;

        const cellUpdates = [];
        this.cellInfo.forEach((info, i) => {
            if (info.matchesSearch) {
                const row = Math.floor(i / cols);
                const col = i - row * cols;
                const cellValue = this.hot.getDataAtCell(row, col);
                cellUpdates.push([row, col, cellValue.split(this.search_query).join(replacement_value)]);
            }
        });

        this.hot.setDataAtCell(cellUpdates);
    },
    toggleToolbelt: function(e){
        const button = e.target;
        const container = button.closest('.wb-header');
        const toolbelt = container.getElementsByClassName('wb-toolbelt')[0];
        if(toolbelt.style.display === 'none')
            toolbelt.style.display = '';
        else
            toolbelt.style.display = 'none';
    },
    fillDownCells: function({start_row,end_row,col}){

        const first_cell = this.hot.getDataAtCell(start_row,col);

        if(isNaN(first_cell))
            return;

        const numeric_part = parseInt(first_cell);

        const changes = [];
        const number_of_rows = end_row - start_row;
        for(let i=0;i<=number_of_rows;i++)
            changes.push([
                start_row+i,
                col,
                (numeric_part+i).toString().padStart(first_cell.length,'0')
            ]);

        this.hot.setDataAtCell(changes);

    },
    find_locality_columns(){
        this.wb.rget('workbenchtemplate').done(wbtemplate => {

            const upload_plan_string = wbtemplate.get('remarks');
            const locality_columns = wb_upload_helper.find_locality_columns(upload_plan_string);

            this.locality_columns = locality_columns.map(locality_mapping =>
                Object.fromEntries(
                    Object.entries(locality_mapping).map(([column_name,header_name])=>
                        [column_name, this.colHeaders.indexOf(header_name)]
                    )
                )
            );

            if(this.locality_columns.length === 0)
                ['wb-geolocate','wb-leafletmap','wb-convert-coordinates'].map(class_name=>
                    document.getElementsByClassName(class_name)[0].disabled = true
                );
        });
    },
    getLocalityCoordinate: function(row, column_indexes, accept_polygons=false){

        const cell_is_valid = (column_name)=>
            typeof column_indexes[column_name] !== "undefined" &&
            column_indexes[column_name] !== -1 &&
            row[column_indexes[column_name]] !== null;

        const format_coordinate = (column_name)=>{
            if(row[column_indexes[column_name]]===0 || row[column_indexes[column_name]] === '0')
                return 0;
            const coordinate = latlongutils.parse(row[column_indexes[column_name]]).toDegs();
            return coordinate._components[0]*coordinate._sign;
        }

        if(
            !cell_is_valid('latitude1') ||
            !cell_is_valid('longitude1')
        )
            return false;

        const point_data = {};
        try {

            point_data['latitude1'] = format_coordinate('latitude1');
            point_data['longitude1'] = format_coordinate('longitude1');

            if(
                accept_polygons &&
                cell_is_valid('latitude2') &&
                cell_is_valid('longitude2') &&
                (
                    !cell_is_valid('latlongtype') ||
                    row[column_indexes['latlongtype']].toLowerCase() !== 'point'
                )
            ) {
                point_data['latitude2'] = format_coordinate('latitude2');
                point_data['longitude2'] = format_coordinate('longitude2');
                point_data['latlongtype'] = (
                    cell_is_valid('latlongtype') &&
                    row[column_indexes['latlongtype']].toLowerCase() === 'line'
                ) ? 'Line' : 'Rectangle';
            }
        }
        catch(e){
            return false;
        }

        if(cell_is_valid('localityname'))
            point_data['localityname'] = row[column_indexes['localityname']];

        if(cell_is_valid('latlongaccuracy'))
            point_data['latlongaccuracy'] = row[column_indexes['latlongaccuracy']];

        return point_data;

    },
    showGeoLocate: function(){

        if(
            this.locality_columns.length === 0 ||
            $('#geolocate_window').length!==0  // don't allow to open more than one window
        )
            return;

        const selected_cell = this.hot.getSelectedLast() || [0,0];

        let [selected_row, selected_column] = selected_cell;
        let locality_columns;

        if(this.locality_columns.length > 1){
            // if there are multiple localities present in a row, check which group this field belongs too
            const locality_columns_to_search_for = ['localityname','latitude1','longitude1','latlongtype', 'latlongaccuracy'];
            if(!this.locality_columns.some(local_locality_columns=>
                Object.fromEntries(local_locality_columns).some((field_name,column_index)=>{
                    if(
                        locality_columns_to_search_for.indexOf(field_name) !== -1 &&
                        column_index === selected_column
                    )
                        return locality_columns = local_locality_columns;
                })
            ))
                return;  // if can not determine the group the column belongs too
        }
        else
            locality_columns = this.locality_columns[0];

        let query_string;

        if(
            typeof locality_columns['country'] !== "undefined" &&
            typeof locality_columns['state'] !== "undefined"
        ){

            const data = Object.fromEntries(['country','state','county','localityname'].map(column_name=>
                [
                    column_name,
                    typeof locality_columns[column_name] === "undefined" ?
                        undefined:
                        encodeURIComponent(this.hot.getDataAtCell(selected_row,locality_columns[column_name]))
                ]
            ));

            query_string = `country=${data['country']}&state=${data['state']}`;

            if(typeof data['county'] !== "undefined")
                query_string += `&county=${data['county']}`;

            if(typeof data['localityname'] !== "undefined")
                query_string += `&locality=${data['localityname']}`;

        }
        else {

            const point_data_dict = this.getLocalityCoordinate(this.hot.getDataAtRow(selected_row), locality_columns);

            if(!point_data_dict)
                return;

            const {latitude1, longitude1, localityname=''} = point_data_dict;

            const point_data_list = [latitude1, longitude1];

            if(localityname !== '')
                point_data_list.push(localityname);

            query_string = `points=${point_data_list.join('|')}`;

        }

        const dialog = $(`
            <div id="geolocate_window">
                <iframe
                    style="
                        width: 100%;
                        height: 100%;
                        border: none;"
                    src="https://www.geo-locate.org/web/WebGeoreflight.aspx?v=1&w=900&h=400&${query_string}"></iframe>
            </div>`
        ).dialog({
            width: 980,
            height: 700,
            resizable: false,
            title: "GEOLocate",
            close: function() { $(this).remove(); },
        });

        const handle_geolocate_result = (event)=>{

            const data_columns = event.data.split('|');
            if (data_columns.length !== 4)
                return;

            Object.entries(
                ['latitude1','longitude1','latlongaccuracy']
            ).map(([index,column])=>{
                if(typeof locality_columns[column] !== "undefined")
                    this.hot.setDataAtCell(selected_row,locality_columns[column],data_columns[index]);
            });

            dialog.dialog('close');
            window.removeEventListener("message", handle_geolocate_result, false);
        };

        window.addEventListener("message", handle_geolocate_result, false);
    },
    showLeafletMap: function(){

        if($('#leaflet_map').length!==0)
            return;

        $(`<div id="leaflet_map"></div>`).dialog({
            width: 900,
            height: 600,
            title: "Leaflet map",
            close: function() { $(this).remove(); },
        });

        const locality_points = this.locality_columns.reduce((locality_points, column_indexes)=>{

            let i=0;
            for(const row of this.hot.getData()) {
                const locality_coordinate = this.getLocalityCoordinate(row,column_indexes,true);

                if(!locality_coordinate)
                    continue;

                locality_coordinate.row_number = i++;
                locality_points.push(locality_coordinate);
            }

            return locality_points;

        },[]);

        const map = L.map('leaflet_map');

        let defaultCenter = [0, 0];
        let defaultZoom = 1;
        if(locality_points.length>0){
            defaultCenter = [locality_points[0]['latitude1'],locality_points[0]['longitude1']];
            defaultZoom = 5;
        }
		const basemap = L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
			maxZoom: 19,
			attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
		});

        map.setView(defaultCenter, defaultZoom);
        basemap.addTo(map);

        let index = 1;

        const create_a_point = (latitude1,longitude1) =>
            L.marker([latitude1,longitude1]);

        locality_points.map(point_data_dict=>{

            const {
                latitude1,
                longitude1,
                latitude2 = false,
                longitude2 = false,
                latlongtype = false,
                latlongaccuracy = false,
                row_number,
            } = point_data_dict;

            let vectors = [];

            if(latitude2===false || longitude2 === false){

                // a point
                if(latlongaccuracy === false || latlongaccuracy === "0")
                    vectors.push(create_a_point(latitude1,longitude1));

                // a circle
                else
                    vectors.push(
                        L.circle([latitude1, longitude1], {
                            radius: latlongaccuracy
                        }),
                        create_a_point(latitude1, longitude1)
                    );

            }


            else
                vectors.push(
                    latlongtype === 'Line' ?
                        // a line
                        new L.Polyline([
                            [latitude1, longitude1],
                            [latitude2, longitude2]
                        ], {
                            weight: 3,
                            opacity: 0.5,
                            smoothFactor: 1
                        }) :
                        // a polygon
                        L.polygon([
                            [latitude1, longitude1],
                            [latitude2, longitude1],
                            [latitude2, longitude2],
                            [latitude1, longitude2]
                        ]),
                    create_a_point(latitude1, longitude1),
                    create_a_point(latitude2, longitude2)
                );


            vectors.map(vector=>{
                vector.addTo(map);
                vector.on('click',()=>{
                    const selected_column =
                        typeof this.hot.getSelectedLast() === "undefined" ?
                            0 :
                            this.hot.getSelectedLast()[1];
                    this.hot.selectCell(row_number,selected_column);  // select first cell to scroll the view
                    this.hot.selectRows(row_number);  // select an entire row
                });
            });

            index++;
        });

    },
    showCoordinateConversion(){

        if($('.latlongformatoptions').length!==0)
            return;

        const column_handlers = {
            'latitude1': 'Lat',
            'longitude1': 'Long',
            'latitude2': 'Lat',
            'longitude2': 'Long',
        };

        const columns_to_search_for = Object.keys(column_handlers);

		const coordinate_columns = this.locality_columns.reduce((coordinate_columns, column_indexes) =>
			[
			    ...coordinate_columns,
                ...Object.entries(column_indexes).filter(([column_name]) =>
				    columns_to_search_for.indexOf(column_name) !== -1
			    )
            ],
			[]
		);

        if(coordinate_columns.length === 0)
        	return;

		const options = [
			{
				option_name: 'DD.DDDD (32.7619)',
				conversion_function_name: 'toDegs',
                show_cardinal_direction: false,
			},
			{
				option_name: 'DD MMMM (32. 45.714)',
				conversion_function_name: 'toDegsMins',
                show_cardinal_direction: false,
			},
			{
				option_name: 'DD MM SS.SS (32 45 42.84)',
				conversion_function_name: 'toDegsMinsSecs',
                show_cardinal_direction: false,
			},
			{
				option_name: 'DD.DDDD N/S/E/W (32.7619 N)',
				conversion_function_name: 'toDegs',
                show_cardinal_direction: true,
			},
			{
				option_name: 'DD MM.MM N/S/E/W (32 45.714 N)',
				conversion_function_name: 'toDegsMins',
                show_cardinal_direction: true,
			},
			{
				option_name: 'DD MM SS.SS N/S/E/W (32 45 42.84 N)',
				conversion_function_name: 'toDegsMinsSecs',
                show_cardinal_direction: true,
			},
		];

		const close_dialog = ()=>{
			dialog.off('change',handle_option_change);
			dialog.remove();
		};

        const dialog = $(
        	`<ul class="latlongformatoptions">
				${Object.values(options).map(({option_name},option_index)=>
					`<li>
						<label>
							<input type="radio" name="latlongformat" value="${option_index}">
							${option_name}
						</label>
					</li>`
				).join('')}
				<li>
					<br>
					<label>
						<input type="checkbox" name="includesymbols">
						Include Symbols
					</label>
				</li>
			</ul>`
        ).dialog({
            title: "Coordinate format converter",
            close: close_dialog,
        	buttons: [
			   {text: 'Close', click: close_dialog }
			]
        });

        const handle_option_change = ()=>{

        	const include_symbols_checkbox = dialog.find('input[name="includesymbols"]');
        	const include_symbols = include_symbols_checkbox.is(':checked');

        	const selected_option = dialog.find('input[type="radio"]:checked');
        	if(selected_option.length===0)
        		return;

			const option_value = selected_option.attr('value');
			if(typeof options[option_value] === "undefined")
				return;

			const {conversion_function_name, show_cardinal_direction} = options[option_value];
			const include_symbols_function = include_symbols ?
				coordinate => coordinate :
				coordinate => coordinate.replace(/[^\w\s\-.]/gm,'');
			const last_char = value => value[value.length-1];
			const remove_last_char = value => value.slice(0,-1);
			const ends_with = (value,charset) => charset.indexOf(last_char(value)) !== -1;
            const strip_cardinal_directions = final_value =>
                show_cardinal_direction ?  // need to do some magic here as a workaround to latlong parsing bugs
                    final_value :
                    ends_with(final_value,'SW') ?
                        '-'+remove_last_char(final_value):
                        ends_with(final_value,'NE') ?
                            remove_last_char(final_value):
                            final_value;

			this.hot.setDataAtCell(
				coordinate_columns.map(([column_name,column_index])=>
					this.hot.getDataAtCol(column_index).map((cell_value,row_index)=>
						[latlongutils[column_handlers[column_name]].parse(cell_value), row_index]
					).filter(([coordinate])=>
						coordinate!==null
					).map(([coordinate,row_index])=>
						[
							row_index,
							column_index,
                            include_symbols_function(
                                strip_cardinal_directions(
                                    coordinate[conversion_function_name]().format()
                                )
                            ).trim()
						]
					)
				).flat()
			);

		};
        dialog.on('change',handle_option_change);
    },
});

module.exports = function loadWorkbench(id) {
    const wb = new schema.models.Workbench.Resource({id: id});
    Q.all([wb.fetch().fail(app.handleError), $.get(`/api/workbench/status/${id}/`)])
        .spread((__, status) => {
            app.setTitle("WorkBench: " + wb.get('name'));

            if (wb.get('srcfilepath') === "uploaded") {
                const view = new WBUploadedView({
                    wb: wb,
                    initialStatus: status
                }).on('refresh', () => loadWorkbench(id));

                app.setCurrentView(view);

            } else {
                const dialog = $('<div><div class="progress-bar"></div></div>').dialog({
                    title: 'Loading',
                    modal: true,
                    open(evt, ui) { $('.ui-dialog-titlebar-close', ui.dialog).hide(); },
                    close() {$(this).remove();}
                });
                $('.progress-bar', dialog).progressbar({value: false});

                Q($.get(`/api/workbench/rows/${id}/`)).done(data => {
                    const view = new WBView({
                        wb: wb,
                        data: data,
                        initialStatus: status
                    }).on('refresh', () => loadWorkbench(id));
                    app.setCurrentView(view);
                });
            }
        });
};
