/*
*
* Contains WbPlanView logic for when the application is in the Mapping State
* (when base table is selected and headers are loaded)
*
* */

'use strict';

import {
	mappings_tree_to_array_of_mappings,
	array_of_mappings_to_mappings_tree,
	traverse_tree,
	array_to_tree, MappingsTree,
}                                                     from './wbplanviewtreehelper';
import { find_duplicate_mappings }                    from './wbplanviewhelper';
import { MappingLine, MappingPath, MappingPathProps } from './wbplanviewcomponents';
import {
	value_is_tree_rank,
	value_is_reference_item,
	get_max_to_many_value,
	format_reference_item,
	show_required_missing_fields,
}                                                     from './wbplanviewmodelhelper';
import navigation                                     from '../navigation';
import { get_mapping_line_data_from_mapping_path }    from './wbplanviewnavigator';
import automapper, { AutoMapperResults }              from './automapper';
import {
	mappings_tree_to_upload_plan,
	UploadPlan,
	upload_plan_to_mappings_tree,
}                                                     from './wbplanviewconverter';
import React                                          from 'react';
import { named_component }                            from './statemanagement';
import {
	ChangeSelectElementValueAction,
	LoadingState, MappingActions,
	MappingState,
	PublicWBPlanViewProps,
	WBPlanViewWrapperProps,
}                                                     from './wbplanview';


export type AutomapperScope = Readonly<'automapper' | 'suggestion'>;
export type MappingPath = string[];
export type ListOfHeaders = string[];
export type MappingType = Readonly<'existing_header' | 'new_column' | 'new_static_column'>;
export type RelationshipType = Readonly<'one-to-one' | 'one-to-many' | 'many-to-one' | 'many-to-many'>;

export interface SelectElementPosition {
	readonly line: number,
	readonly index: number,
}

export interface OpenSelectElement extends SelectElementPosition {
	readonly autoscroll: boolean,
}

interface MappingLine {
	readonly type: MappingType,
	readonly name: string,
	readonly mapping_path: MappingPath,
	readonly is_focused?: boolean,
}

export interface AutomapperSuggestion extends MappingPathProps {
	mapping_path: MappingPath,
}

export interface WBPlanViewMapperBaseProps {
	readonly mapping_is_templated: boolean,
	readonly show_hidden_fields: boolean,
	readonly show_mapping_view: boolean,
	readonly base_table_name: string,
	// the index that would be shown in the header name the next time the user presses `New Column`
	readonly new_header_id: number,
	readonly mapping_view: MappingPath,
	readonly validation_results: MappingPath[],
	readonly lines: MappingLine[],
	readonly open_select_element?: OpenSelectElement,
	readonly focused_line?: number,
	readonly automapper_suggestions?: AutomapperSuggestion[],
	readonly autoscroll?: boolean,
}

export type GetMappedFieldsBind = (
	mapping_path_filter: MappingPath,  // a mapping path that would be used as a filter
) => MappingsTree;

export type PathIsMappedBind = (
	mapping_path_filter: MappingPath,  // a mapping path that would be used as a filter
) => boolean;


const max_suggestions_count = 3;  // the maximum amount suggestions to show in the suggestions box

const MappingsControlPanel = React.memo(named_component(({
	show_hidden_fields,
	handleChange,
	handleAddNewColumn,
	handleAddNewStaticColumn,
}: {
	readonly show_hidden_fields: boolean,
	readonly handleChange: () => void,
	readonly handleAddNewColumn: () => void,
	readonly handleAddNewStaticColumn: () => void,
}) =>
	<div className="mappings_control_panel">
		<button onClick={handleAddNewColumn}>Add new column</button>
		<button onClick={handleAddNewStaticColumn}>Add new static column</button>
		<label>
			<input
				type="checkbox"
				checked={show_hidden_fields}
				onChange={handleChange}
			/>
			Reveal hidden fields
		</label>
	</div>, 'MappingsControlPanel'));

function FormatValidationResults(props: {
	readonly base_table_name: string,
	readonly validation_results: MappingPath[],
	readonly handleSave: () => void
	readonly get_mapped_fields: GetMappedFieldsBind,
}) {
	if (props.validation_results.length === 0)
		return null;

	return <div className="validation_results">
		<span>The following fields should be mapped before you can upload the dataset:</span>
		{props.validation_results.map((field_path, index) =>
			<div className="wbplanview_mapping_line_elements" key={index}>
				<MappingPath
					mapping_line_data={get_mapping_line_data_from_mapping_path({
						base_table_name: props.base_table_name,
						mapping_path: field_path,
						generate_last_relationship_data: false,
						custom_select_type: 'preview_list',
						get_mapped_fields: props.get_mapped_fields,
					})}
				/>
			</div>,
		)}
		<span>
			Or you can <button onClick={props.handleSave}>Save Unfinished Mapping</button> and finish editing it later
		</span>
	</div>;
}

export const go_back = (props: PublicWBPlanViewProps): void =>
	navigation.go(`/workbench/${props.wb.id}/`);


// export const go_back = ( props: PublicWBPlanViewProps): LoadingState => (
// 	{
// 		type: 'LoadingState',
// 		loading_state: {
// 			type: 'NavigateBackState',
// 			wb: props.wb,
// 		},
// 	}
// );

export function save_plan(
	props: WBPlanViewWrapperProps,
	state: MappingState,
	ignore_validation = false,
): LoadingState | MappingState {
	const validation_results_state = validate(state);
	if (!ignore_validation && validation_results_state.validation_results.length !== 0)
		return validation_results_state;

	props.wb.set('ownerPermissionLevel', props.mapping_is_templated ? 1 : 0);
	props.wb_template_promise.done(wbtemplate =>
		wbtemplate.set('remarks', mappings_tree_to_upload_plan(state.base_table_name, get_mappings_tree(state.lines, true))),
	);
	try {  // react may call `save_plan` multiple times
		props.wb.save();  // Since the function has side effects, calling props.wb.save() second time causes an exception
	}
	catch (e) {
		console.log('React called `save_plan()` function twice');
	}

	if (state.changes_made)
		props.remove_unload_protect();

	go_back(props);
	return state;
}

/* Validates the current mapping and shows error messages if needed */
export function validate(state: MappingState): MappingState {

	const validation_results = show_required_missing_fields(
		state.base_table_name,
		get_mappings_tree(state.lines, true),
	);

	return {
		...state,
		type: 'MappingState',
		show_mapping_view:  // Show mapping view panel if there were validation errors
			state.show_mapping_view ||
			Object.values(validation_results).length !== 0,
		validation_results,
	};
}

export function get_lines_from_headers({
	headers = [],
	run_automapper,
	base_table_name = '',
}: {
	headers?: ListOfHeaders
} & (
	{
		run_automapper: true,
		base_table_name: string,
	} |
	{
		run_automapper: false,
		base_table_name?: string,
	}
	)): MappingLine[] {

	const lines = headers.map((header_name): MappingLine => (
		{
			mapping_path: ['0'],
			type: 'existing_header',
			name: header_name,
		}
	));

	if (!run_automapper || typeof base_table_name === 'undefined')
		return lines;

	const automapper_results: AutoMapperResults = (
		new automapper({
			headers: headers,
			base_table: base_table_name,
			scope: 'automapper',
			check_for_existing_mappings: false,
		})
	).map();

	return lines.map(line => {
		const {name: header_name} = line;
		const automapper_mapping_paths = automapper_results[header_name];
		if (typeof automapper_mapping_paths === 'undefined')
			return line;
		else
			return {
				mapping_path: automapper_mapping_paths[0],
				type: 'existing_header',
				name: header_name,
			};
	});

}

export function get_lines_from_upload_plan(
	headers: ListOfHeaders = [],
	upload_plan: UploadPlan,
): {
	readonly base_table_name: string,
	readonly lines: MappingLine[],
} {

	const lines = get_lines_from_headers({
		headers,
		run_automapper: false,
	});
	const {base_table_name, mappings_tree} = upload_plan_to_mappings_tree(headers, upload_plan);
	const array_of_mappings = mappings_tree_to_array_of_mappings(mappings_tree);
	array_of_mappings.forEach(full_mapping_path => {
		const [
			mapping_path,
			mapping_type,
			header_name,
		] = [
			full_mapping_path.slice(0, -2),
			full_mapping_path.slice(-2, -1)[0],
			full_mapping_path.slice(-1)[0],
		] as [
			MappingPath,
			MappingType,
			string
		];
		const header_index = headers.indexOf(header_name);
		if (header_index !== -1)
			lines[header_index] = {
				mapping_path,
				type: mapping_type,
				name: header_name,
			};
	});

	return {
		base_table_name: base_table_name,
		lines,
	};

}

const get_array_of_mappings = (
	lines: MappingLine[],
	include_headers = false,
): MappingPath[] =>
	lines.filter(({mapping_path}) =>
		mapping_path_is_complete(mapping_path),
	).map(({mapping_path, type, name}) =>
		include_headers ?
			[...mapping_path, type, name] :
			mapping_path,
	);

export const get_mappings_tree = (
	lines: MappingLine[],
	include_headers = false,
): MappingsTree =>
	array_of_mappings_to_mappings_tree(
		get_array_of_mappings(lines, include_headers),
	);

/* Get a mappings tree branch given a particular starting mapping path */
export function get_mapped_fields(
	lines: MappingLine[],
	mapping_path_filter: MappingPath,  // a mapping path that would be used as a filter
): MappingsTree {
	const mappings_tree = traverse_tree(
		get_mappings_tree(lines),
		array_to_tree([...mapping_path_filter]),
	);
	return typeof mappings_tree === 'object' ?
		mappings_tree :
		{};
}

export const path_is_mapped = (lines: MappingLine[], mapping_path: MappingPath): boolean =>
	Object.keys(get_mapped_fields(lines, mapping_path.slice(0, -1))).indexOf(mapping_path.slice(-1)[0]) !== -1;


export const mapping_path_is_complete = (mapping_path: MappingPath): boolean =>
	mapping_path[mapping_path.length - 1] !== '0';

/* Unmap headers that have a duplicate mapping path */
export function deduplicate_mappings(
	lines: MappingLine[],
	focused_line: number | false,
): MappingLine[] {

	const array_of_mappings = get_array_of_mappings(lines);
	const duplicate_mapping_indexes = find_duplicate_mappings(array_of_mappings, focused_line);

	return lines.map((line, index) =>
		duplicate_mapping_indexes.indexOf(index) === -1 ?
			line :
			{
				...line,
				mapping_path: line.mapping_path.slice(0, -1),
			},
	);

}


/*
* Show automapper suggestion on top of an opened `closed_list`
* The automapper suggestions are shown only if the current box doesn't have a value selected
* */
export const get_automapper_suggestions = ({
	lines,
	line,
	index,
	base_table_name,
}: SelectElementPosition & {
	readonly lines: MappingLine[],
	readonly base_table_name: string,
}): Promise<AutomapperSuggestion[]> =>
	new Promise((resolve) => {

		const local_mapping_path = [...lines[line].mapping_path];

		if (  // don't show suggestions
			(  // if opened picklist has a value selected
				local_mapping_path.length - 1 !== index ||
				mapping_path_is_complete(local_mapping_path)
			) ||  // or if header is a new column / new static column
			lines[line].type !== 'existing_header'
		)
			return resolve([]);

		const mapping_line_data = get_mapping_line_data_from_mapping_path({
			base_table_name,
			mapping_path: mapping_path_is_complete(local_mapping_path) ?
				local_mapping_path :
				local_mapping_path.slice(0, local_mapping_path.length - 1),
			iterate: false,
			custom_select_type: 'suggestion_list',
			get_mapped_fields: get_mapped_fields.bind(null, lines),
		});

		// don't show suggestions if picklist has only one field / no fields
		if (
			mapping_line_data.length === 1 &&
			Object.keys(mapping_line_data[0].fields_data).length < 2
		)
			return resolve([]);

		const base_mapping_path = local_mapping_path.slice(0, -1);

		let path_offset = 0;
		if (mapping_line_data.length === 1 && mapping_line_data[0].custom_select_subtype === 'to_many') {
			base_mapping_path.push('#1');
			path_offset = 1;
		}

		const all_automapper_results = Object.entries((
			new automapper({
				headers: [lines[line].name],
				base_table: base_table_name,
				starting_table: mapping_line_data.length === 0 ?
					base_table_name :
					mapping_line_data[mapping_line_data.length - 1].table_name,
				path: base_mapping_path,
				path_offset,
				allow_multiple_mappings: true,
				check_for_existing_mappings: true,
				scope: 'suggestion',
				path_is_mapped: path_is_mapped.bind(null, lines),
			})
		).map({
			commit_to_cache: false,
		}));

		if (all_automapper_results.length === 0)
			return resolve([]);

		let automapper_results = all_automapper_results[0][1];

		if (automapper_results.length > max_suggestions_count)
			automapper_results = automapper_results.slice(0, 3);

		resolve(automapper_results.map(automapper_result => (
			{
				mapping_path: automapper_result,
				mapping_line_data: get_mapping_line_data_from_mapping_path({
					base_table_name,
					mapping_path: automapper_result,
					custom_select_type: 'suggestion_line_list',
					get_mapped_fields: get_mapped_fields.bind(null, lines),
				}).slice(base_mapping_path.length - path_offset),
			}
		)));

	});

const MappingView = React.memo(named_component((props: {
	readonly base_table_name: string,
	readonly focused_line_exists: boolean,
	readonly mapping_path: MappingPath,
	readonly map_button_is_enabled: boolean,
	readonly handleMapButtonClick: () => void
	readonly handleMappingViewChange: (
		index: number,
		new_value: string,
		is_relationship: boolean,
	) => void,
	readonly get_mapped_fields: GetMappedFieldsBind,
	readonly automapper_suggestions?: AutomapperSuggestion[],
	readonly show_hidden_fields?: boolean,
}) =>
	<>
		<div className="mapping_view">
			<MappingPath
				mapping_line_data={get_mapping_line_data_from_mapping_path({
					base_table_name: props.base_table_name,
					mapping_path: props.mapping_path,
					generate_last_relationship_data: true,
					custom_select_type: 'opened_list',
					handleChange: props.handleMappingViewChange,
					get_mapped_fields: props.get_mapped_fields,
					show_hidden_fields: props.show_hidden_fields,
				})}
			/>
		</div>
		<button
			className="wbplanview_mapping_view_map_button"
			disabled={!props.map_button_is_enabled}
			onClick={
				props.map_button_is_enabled && props.focused_line_exists ?
					props.handleMapButtonClick :
					undefined
			}
		>
			Map
			<span className="wbplanview_mapping_view_map_button_arrow">&#8594;</span>
		</button>
	</>, 'MappingView'));

export function mutate_mapping_path({
	lines,
	mapping_view,
	line,
	index,
	value,
	is_relationship,
}: Omit<ChangeSelectElementValueAction, 'type'> & {
	readonly lines: MappingLine[],
	readonly mapping_view: MappingPath,
	readonly is_relationship: boolean,
}): MappingPath {

	let mapping_path = [...(
		line === 'mapping_view' ?
			mapping_view :
			lines[line].mapping_path
	)];

	const is_simple = !value_is_reference_item(value) && !value_is_tree_rank(value);

	if (value === 'add') {
		const mapped_fields = Object.keys(get_mapped_fields(lines, mapping_path.slice(0, index)));
		const max_to_many_value = get_max_to_many_value(mapped_fields);
		mapping_path[index] = format_reference_item(max_to_many_value + 1);
	}
	else if (is_simple)
		mapping_path = [...mapping_path.slice(0, index), value];
	else
		mapping_path[index] = value;

	if ((
		!is_simple || is_relationship
	) && mapping_path.length - 1 === index)
		return [...mapping_path, '0'];

	return mapping_path;

}

export default named_component((props: WBPlanViewMapperBaseProps & {
	readonly mapper_dispatch: (action: MappingActions) => void,
	readonly handleSave: () => void,
	readonly handleFocus: (line_index: number) => void,
	readonly handleMappingViewMap: () => void,
	readonly handleAddNewHeader: () => void,
	readonly handleAddNewStaticHeader: () => void,
	readonly handleToggleHiddenFields: () => void,
	readonly handleAddNewColumn: () => void,
	readonly handleAddNewStaticColumn: () => void,
	readonly handleAutoScrollFinish: () => void,
	readonly handleOpen: (
		line: |number,
		index: number,
	) => void;
	readonly handleClose: () => void
	readonly handleChange: (
		line: 'mapping_view' | number,
		index: number,
		new_value: string,
		is_relationship: boolean,
	) => void,
	readonly handleClearMapping: (
		index: number,
	) => void,
	readonly handleStaticHeaderChange: (index: number, event: React.ChangeEvent<HTMLTextAreaElement>) => void,
	readonly handleAutomapperSuggestionSelection: (suggestion: string) => void,
}) => {
	const get_mapped_fields_bind = get_mapped_fields.bind(null, props.lines);
	const list_of_mappings = React.useRef<HTMLDivElement>(null);

	//scroll down the list of mappings when the `add_new_column` or `add_new_static_column` was clicked
	React.useEffect(() => {
		if (props.autoscroll && list_of_mappings.current) {
			list_of_mappings.current.scrollTop = list_of_mappings.current.scrollHeight;
			props.handleAutoScrollFinish();
		}
	});

	return <>
		{
			props.show_mapping_view &&
			<div className="mapping_view_parent">
				<div className="mapping_view_container">
					<FormatValidationResults
						base_table_name={props.base_table_name}
						validation_results={props.validation_results}
						handleSave={props.handleSave}
						get_mapped_fields={get_mapped_fields_bind}
					/>
					<MappingView
						base_table_name={props.base_table_name}
						focused_line_exists={typeof props.focused_line !== 'undefined'}
						mapping_path={props.mapping_view}
						show_hidden_fields={props.show_hidden_fields}
						map_button_is_enabled={
							typeof props.focused_line !== 'undefined' &&
							mapping_path_is_complete(props.mapping_view)
						}
						handleMapButtonClick={props.handleMappingViewMap}
						handleMappingViewChange={props.handleChange.bind(null, 'mapping_view')}
						get_mapped_fields={get_mapped_fields_bind}
						automapper_suggestions={props.automapper_suggestions}
					/>
				</div>
			</div>
		}

		<div className="list__mappings" ref={list_of_mappings}>{
			props.lines.map(({mapping_path, name, type}, index) =>
				<MappingLine
					key={index}
					header_name={name}
					mapping_type={type}
					is_focused={index === props.focused_line}
					handleFocus={props.handleFocus.bind(null, index)}
					handleClearMapping={props.handleClearMapping.bind(null, index)}
					handleStaticHeaderChange={props.handleStaticHeaderChange.bind(null, index)}
					line_data={
						get_mapping_line_data_from_mapping_path({
							base_table_name: props.base_table_name,
							mapping_path: mapping_path,
							generate_last_relationship_data: true,
							custom_select_type: 'closed_list',
							handleChange: props.handleChange.bind(null, index),
							handleOpen: props.handleOpen.bind(null, index),
							handleClose: props.handleClose.bind(null, index),
							handleAutomapperSuggestionSelection: props.handleAutomapperSuggestionSelection,
							get_mapped_fields: get_mapped_fields_bind,
							open_select_element:
								typeof props.open_select_element !== 'undefined' && props.open_select_element.line === index ?
									props.open_select_element :
									undefined,
							show_hidden_fields: props.show_hidden_fields,
							automapper_suggestions: props.automapper_suggestions,
						})
					}
				/>,
			)
		}</div>

		<MappingsControlPanel
			show_hidden_fields={props.show_hidden_fields}
			handleChange={props.handleToggleHiddenFields}
			handleAddNewColumn={props.handleAddNewColumn}
			handleAddNewStaticColumn={props.handleAddNewStaticColumn}
		/>
	</>;

}, 'WBPlanViewMappingState');