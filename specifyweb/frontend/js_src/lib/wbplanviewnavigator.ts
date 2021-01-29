/*
*
* Helpful methods for navigating though schema across a certain mapping path.
* Helps define information needed to display wbplanview components
*
* */

'use strict';

import {
	value_is_reference_item,
	value_is_tree_rank,
	relationship_is_to_many,
	table_is_tree,
	format_tree_rank,
	get_name_from_tree_rank_name,
	get_max_to_many_value,
	format_reference_item, is_circular_relationship, is_too_many_inside_of_too_many,
}                                                      from './wbplanviewmodelhelper';
import data_model_storage                              from './wbplanviewmodel';
import {
	AutomapperSuggestion,
	GetMappedFieldsBind,
	MappingPath,
	OpenSelectElement,
	RelationshipType,
}                                                      from './components/wbplanviewmapper';
import { DataModelField, DataModelRelationship }       from './wbplanviewmodelfetcher';
import { CustomSelectSubtype, CustomSelectType }       from './components/customselectelement';
import { HtmlGeneratorFieldData, MappingElementProps } from './components/wbplanviewcomponents';


interface FindNextNavigationDirectionBase {
	finished: boolean,
}

type FindNextNavigationDirection<RETURN_STRUCTURE> = FindNextNavigationDirectionBase &
	(
		{
			finished: true,
			final_data: RETURN_STRUCTURE[],
		} | {
		finished: false,
		payload: {
			next_table_name: string,
			next_parent_table_name: string,
			next_real_path_element_name: string,
			next_path_element_name: string,
		},
	}
		)

interface NavigationCallbackPayload<RETURN_TYPE> {
	table_name: string,
	data?: RETURN_TYPE,
	parent_relationship_type?: RelationshipType,
	parent_table_name?: string,
}

type NavigatorCallbackFunction<RETURN_STRUCTURE, RETURN_TYPE> = (
	callback_payload: Readonly<NavigationCallbackPayload<RETURN_STRUCTURE>>,
) => RETURN_TYPE;

interface NavigationCallbacks<RETURN_STRUCTURE> {
	// should return {boolean} specifying whether to run data_model.navigator_instance() for a particular mapping path part
	readonly iterate: NavigatorCallbackFunction<RETURN_STRUCTURE, boolean>,
	// should return undefined if next element does not exist
	readonly get_next_path_element: NavigatorCallbackFunction<RETURN_STRUCTURE, {
		readonly next_path_element_name: string,  // the name of the next path element
		// if the next path element is not a field nor a relationship, {undefined}.
		// Else, {object} the information about a field from data_model.tables
		readonly next_path_element: DataModelField,
		// If next_path_element_name is not a field nor a relationships, {string} current path element name.
		// Else next_path_element_name
		readonly next_real_path_element_name: string,
	} | undefined>,
	// formats internal_payload and returns it. Would be used as a return value for the navigator
	readonly get_final_data: NavigatorCallbackFunction<RETURN_STRUCTURE, RETURN_STRUCTURE[]>,
	// commits callback_payload.data to internal_payload and returns committed data
	readonly get_instance_data: NavigatorCallbackFunction<RETURN_STRUCTURE, RETURN_STRUCTURE>,
	// commits callback_payload.data to internal_payload and returns committed data
	readonly commit_instance_data: NavigatorCallbackFunction<RETURN_STRUCTURE, RETURN_STRUCTURE>,
	// called inside of navigator_instance before it calls callbacks for tree ranks / reference items / simple fields
	readonly navigator_instance_pre: NavigatorCallbackFunction<RETURN_STRUCTURE, void>,
	// handles to_many children
	readonly handle_to_many_children: NavigatorCallbackFunction<RETURN_STRUCTURE, void>,
	// handles tree ranks children
	readonly handle_tree_ranks: NavigatorCallbackFunction<RETURN_STRUCTURE, void>,
	// handles fields and relationships
	readonly handle_simple_fields: NavigatorCallbackFunction<RETURN_STRUCTURE, void>,
}


function find_next_navigation_direction<RETURN_STRUCTURE>(
	callbacks: NavigationCallbacks<RETURN_STRUCTURE>,
	callback_payload: Readonly<NavigationCallbackPayload<RETURN_STRUCTURE>>,
	table_name: string,
	parent_table_name: string,
): FindNextNavigationDirection<RETURN_STRUCTURE> {
	const next_path_elements_data = callbacks.get_next_path_element(callback_payload);

	if (typeof next_path_elements_data === 'undefined')
		return {
			finished: true,
			final_data: callbacks.get_final_data(callback_payload),
		};

	const {
		next_path_element_name,
		next_path_element,
		next_real_path_element_name,
	} = next_path_elements_data;

	let next_table_name = '';
	let next_parent_table_name = '';

	if (
		value_is_reference_item(next_path_element_name) ||
		value_is_tree_rank(next_path_element_name)
	) {
		next_table_name = table_name;
		next_parent_table_name = parent_table_name;
	}
	else if (typeof next_path_element !== 'undefined' && next_path_element.is_relationship) {
		next_table_name = next_path_element.table_name;
		next_parent_table_name = table_name;
	}

	return {
		finished: false,
		payload: {
			next_table_name,
			next_parent_table_name,
			next_real_path_element_name,
			next_path_element_name,
		},
	};
}

/* Navigates though the schema according to a specified mapping path and calls certain callbacks while doing that */
export function navigator<RETURN_STRUCTURE>({
	callbacks,
	recursive_payload = undefined,
	config: {
		base_table_name,
	},
}: {
	// Callbacks can be modified depending on the need to make navigator versatile
	readonly callbacks: NavigationCallbacks<RETURN_STRUCTURE>,
	// {object|undefined} used internally to make navigator call itself multiple times
	readonly recursive_payload?: {
		readonly table_name: string,
		readonly parent_table_name: string,
		readonly parent_table_relationship_name: string,
		readonly parent_path_element_name: string,
	}
	readonly config: {
		readonly base_table_name?: string  // the name of the base table to use
	}
}): RETURN_STRUCTURE[] {

	let table_name = '';
	let parent_table_name = '';
	let parent_table_relationship_name = '';
	let parent_path_element_name = '';

	if (typeof recursive_payload === 'undefined') {
		if (typeof base_table_name === 'undefined')
			throw new Error('Base table needs to be specified for a navigator to be able to loop though schema');
		table_name = base_table_name;
	}
	else
		(
			{
				table_name,
				parent_table_name,
				parent_table_relationship_name,
				parent_path_element_name,
			} = recursive_payload
		);

	const callback_payload = {  // an object that is shared between navigator, navigator_instance and some callbacks
		table_name,
	};


	if (callbacks.iterate(callback_payload))
		navigator_instance<RETURN_STRUCTURE>({
			table_name,
			parent_table_name,
			parent_table_relationship_name,
			parent_path_element_name,
			callbacks,
			callback_payload,
		});


	const next_navigation_direction = find_next_navigation_direction<RETURN_STRUCTURE>(
		callbacks,
		callback_payload,
		table_name,
		parent_table_name,
	);

	if (next_navigation_direction.finished)
		return next_navigation_direction.final_data;

	const {
		next_path_element_name,
		next_table_name,
		next_parent_table_name,
		next_real_path_element_name,
	} = next_navigation_direction.payload;

	let schema_navigator_results: RETURN_STRUCTURE[] = [];

	if (next_table_name !== '')
		schema_navigator_results = navigator(
			{
				callbacks,
				recursive_payload: {
					table_name: next_table_name,
					parent_table_name: next_parent_table_name,
					parent_table_relationship_name: next_real_path_element_name,
					parent_path_element_name: next_path_element_name,
				},
				config: {},
			},
		);

	return schema_navigator_results.length === 0 ?
		callbacks.get_final_data(callback_payload) :
		schema_navigator_results;

}

function get_navigation_children_types(
	parent_table_name: string,
	parent_table_relationship_name: string,
	parent_path_element_name: string,
	table_name: string,
) {
	const parent_relationship_type: RelationshipType | undefined =
		(
			data_model_storage.tables[parent_table_name]?.fields[parent_table_relationship_name] as DataModelRelationship
		)?.type;

	return {
		parent_relationship_type,
		children_are_to_many_elements:
			relationship_is_to_many(parent_relationship_type) &&
			!value_is_reference_item(parent_path_element_name),
		children_are_ranks:
			table_is_tree(table_name) &&
			!value_is_tree_rank(parent_path_element_name),
	};
}

function call_navigator_instance_callbacks<RETURN_STRUCTURE>(
	children_are_to_many_elements: boolean,
	children_are_ranks: boolean,
	callbacks: NavigationCallbacks<RETURN_STRUCTURE>,
	callback_payload: Readonly<NavigationCallbackPayload<RETURN_STRUCTURE>>,
) {
	if (children_are_to_many_elements)
		callbacks.handle_to_many_children(callback_payload);
	else if (children_are_ranks)
		callbacks.handle_tree_ranks(callback_payload);
	else
		callbacks.handle_simple_fields(callback_payload);
}

/* Called by navigator if callback.iterate returned true */
function navigator_instance<RETURN_STRUCTURE>({
	table_name,
	parent_table_name = '',
	parent_table_relationship_name = '',
	parent_path_element_name = '',
	callbacks,
	callback_payload,
}: {
	readonly table_name: string,  // the name of the current table
	readonly parent_table_name?: string,  // parent table name
	// next_real_path_element_name as returned by callbacks.get_next_path_element
	readonly parent_table_relationship_name?: string,
	readonly parent_path_element_name?: string,  // next_path_element_name as returned by callbacks.get_next_path_element
	readonly callbacks: NavigationCallbacks<RETURN_STRUCTURE>  // callbacks (described in the navigator)
	// callbacks payload (described in the navigator)
	readonly callback_payload: NavigationCallbackPayload<RETURN_STRUCTURE>
}): RETURN_STRUCTURE {


	const {
		parent_relationship_type,
		children_are_to_many_elements,
		children_are_ranks,
	} = get_navigation_children_types(
		parent_table_name,
		parent_table_relationship_name,
		parent_path_element_name,
		table_name,
	);

	if (children_are_to_many_elements && children_are_ranks)
		throw new Error('Unable to properly determine picklist type');

	callbacks.navigator_instance_pre(callback_payload);

	callback_payload.parent_relationship_type = parent_relationship_type;
	callback_payload.parent_table_name = parent_table_name;

	call_navigator_instance_callbacks(
		children_are_to_many_elements,
		children_are_ranks,
		callbacks,
		callback_payload,
	);


	const data = callbacks.get_instance_data(callback_payload);
	callback_payload.data = data;
	callbacks.commit_instance_data(callback_payload);

	return data;

}


/*
* Get data required to build a mapping line from a source mapping path and other options
* */
export function get_mapping_line_data_from_mapping_path({
	base_table_name,
	mapping_path = ['0'],
	open_select_element,
	iterate = true,
	generate_last_relationship_data = true,
	custom_select_type,
	handleChange,
	handleOpen,
	handleClose,
	handleAutomapperSuggestionSelection,
	get_mapped_fields,
	automapper_suggestions,
	show_hidden_fields = true,
}: {
	readonly base_table_name: string,
	readonly mapping_path?: MappingPath,  // the mapping path
	readonly open_select_element?: OpenSelectElement  // index of custom select element that should be open
	// {bool} if False, returns data only for the last element of the mapping path only
	// Else returns data for each mapping path part
	readonly iterate?: boolean,
	// {bool} whether to generate data for the last element of the mapping path if the last element is a relationship
	readonly generate_last_relationship_data?: boolean
	readonly custom_select_type: CustomSelectType,
	readonly show_hidden_fields?: boolean,
	readonly handleChange?: (
		index: number,
		new_value: string,
		is_relationship: boolean,
	) => void,
	readonly handleOpen?: (
		index: number,
	) => void
	readonly handleClose?: (
		index: number,
	) => void
	readonly handleAutomapperSuggestionSelection?: (suggestion: string) => void,
	readonly get_mapped_fields: GetMappedFieldsBind,
	readonly automapper_suggestions?: AutomapperSuggestion[],
}): MappingElementProps[] {

	const internal_state: {
		mapping_path_position: number,
		mapping_line_data: MappingElementProps[],
		custom_select_type: CustomSelectType,
		custom_select_subtype?: CustomSelectSubtype
		is_open?: boolean,
		next_mapping_path_element?: string,
		default_value?: string,
		current_mapping_path_part?: string,
		result_fields: {[field_name: string]: HtmlGeneratorFieldData}
		mapped_fields: string[],
	} = {
		mapping_path_position: -1,
		mapping_line_data: [],
		custom_select_type,
		mapped_fields: [],
		result_fields: {},
		is_open: false,
	};

	const first_iteration_requirement = () =>
		iterate ||
		mapping_path.length === 0 ||
		internal_state.mapping_path_position + 1 === mapping_path.length;

	const second_iteration_requirement = () =>
		generate_last_relationship_data ||
		internal_state.mapping_path_position + 1 !== mapping_path.length;

	const is_field_visible = (show_hidden_fields: boolean, is_hidden: boolean, field_name: string) =>
		show_hidden_fields ||
		!is_hidden ||
		field_name === internal_state.default_value; // show a default field, even if it is hidden

	const callbacks: NavigationCallbacks<MappingElementProps> = {

		iterate: () =>
			first_iteration_requirement() && second_iteration_requirement(),

		get_next_path_element({table_name}) {

			if (internal_state.mapping_path_position === -2)
				internal_state.mapping_path_position = mapping_path.length - 1;

			internal_state.mapping_path_position++;

			let next_path_element_name = mapping_path[internal_state.mapping_path_position];

			if (typeof next_path_element_name == 'undefined')
				return undefined;

			const formatted_tree_rank_name = format_tree_rank(next_path_element_name);
			const tree_rank_name = get_name_from_tree_rank_name(formatted_tree_rank_name);
			if (table_is_tree(table_name) && typeof data_model_storage.ranks[table_name][tree_rank_name] !== 'undefined') {
				next_path_element_name = formatted_tree_rank_name;
				mapping_path[internal_state.mapping_path_position] = formatted_tree_rank_name;
			}

			let next_real_path_element_name;
			if (value_is_tree_rank(next_path_element_name) || value_is_reference_item(next_path_element_name))
				next_real_path_element_name = mapping_path[internal_state.mapping_path_position - 1];
			else
				next_real_path_element_name = next_path_element_name;

			return {
				next_path_element_name,
				next_path_element: data_model_storage.tables[table_name].fields[next_path_element_name],
				next_real_path_element_name,
			};

		},

		navigator_instance_pre({table_name}) {

			internal_state.is_open =
				(
					open_select_element?.index === internal_state.mapping_path_position + 1
				) ||
				['opened_list'].indexOf(internal_state.custom_select_type) !== -1;

			internal_state.custom_select_subtype = 'simple';

			const local_mapping_path = mapping_path.slice(0, internal_state.mapping_path_position + 1);

			internal_state.next_mapping_path_element = mapping_path[internal_state.mapping_path_position + 1];

			if (typeof internal_state.next_mapping_path_element === 'undefined')
				internal_state.default_value = '0';
			else {
				const formatted_tree_rank_name = format_tree_rank(internal_state.next_mapping_path_element);
				const tree_rank_name = get_name_from_tree_rank_name(formatted_tree_rank_name);
				if (table_is_tree(table_name) && typeof data_model_storage.ranks[table_name][tree_rank_name] !== 'undefined') {
					internal_state.next_mapping_path_element = formatted_tree_rank_name;
					mapping_path[internal_state.mapping_path_position] = formatted_tree_rank_name;
				}

				internal_state.default_value = internal_state.next_mapping_path_element;

			}

			internal_state.current_mapping_path_part = mapping_path[internal_state.mapping_path_position];
			internal_state.result_fields = {};
			internal_state.mapped_fields = Object.keys(get_mapped_fields(local_mapping_path));
		},

		handle_to_many_children({table_name}) {

			internal_state.custom_select_subtype = 'to_many';

			if (typeof internal_state.next_mapping_path_element !== 'undefined')
				internal_state.mapped_fields.push(internal_state.next_mapping_path_element);

			const max_mapped_element_number = get_max_to_many_value(internal_state.mapped_fields);

			for (let i = 1; i <= max_mapped_element_number; i++) {
				const mapped_object_name = format_reference_item(i);

				internal_state.result_fields[mapped_object_name] = {
					field_friendly_name: mapped_object_name,
					is_enabled: true,
					is_required: false,
					is_hidden: false,
					is_relationship: true,
					is_default: mapped_object_name === internal_state.default_value,
					table_name,
				};
			}
			internal_state.result_fields.add = {
				field_friendly_name: 'Add',
				is_enabled: true,
				is_required: false,
				is_hidden: false,
				is_relationship: true,
				is_default: false,
				table_name,
			};

		},

		handle_tree_ranks({table_name}) {

			internal_state.custom_select_subtype = 'tree';
			const table_ranks = data_model_storage.ranks[table_name];

			internal_state.result_fields = Object.fromEntries(
				Object.entries(table_ranks).map(([rank_name, is_required]) => [
					format_tree_rank(rank_name),
					{
						field_friendly_name: rank_name,
						is_enabled: true,
						is_required,
						is_hidden: false,
						is_relationship: true,
						is_default: format_tree_rank(rank_name) === internal_state.default_value,
						table_name,
					},
				]),
			);

		},

		handle_simple_fields: ({
			table_name,
			parent_table_name,
			parent_relationship_type,
		}) => (
			internal_state.result_fields = Object.fromEntries(
				Object.entries(data_model_storage.tables[table_name].fields).filter((
					[
						field_name,
						{
							is_relationship,
							type: relationship_type,
							is_hidden,
							foreign_name,
							table_name: field_table_name,
						},
					],
					) =>
					(
						!is_relationship ||
						!is_circular_relationship({  // skip circular relationships
							target_table_name: field_table_name,
							parent_table_name,
							foreign_name,
							relationship_key: field_name,
							current_mapping_path_part: internal_state.current_mapping_path_part,
							table_name: parent_table_name,
						})
					) &&
					// skip -to-many inside -to-many  // TODO: remove this once upload plan is ready
					!is_too_many_inside_of_too_many(relationship_type, parent_relationship_type) &&
					// skip hidden fields when user decided to hide them
					is_field_visible(show_hidden_fields, is_hidden, field_name),
				).map((
					[
						field_name,
						{
							is_relationship,
							is_hidden,
							is_required,
							friendly_name,
							table_name: field_table_name,
						},
					],
				) => [
					field_name,
					{
						field_friendly_name: friendly_name,
						is_enabled:  // disable field
							internal_state.mapped_fields.indexOf(field_name) === -1 ||  // if it is mapped
							is_relationship,  // or is a relationship,
						is_required,
						is_hidden,
						is_default: field_name === internal_state.default_value,
						is_relationship,
						table_name: field_table_name,
					},
				]),
			)
		),

		get_instance_data: ({table_name}) => (
			{
				custom_select_type: internal_state.custom_select_type,
				custom_select_subtype: internal_state.custom_select_subtype,
				select_label: data_model_storage.tables[table_name].table_friendly_name,
				fields_data: internal_state.result_fields,
				table_name,
				...(
					internal_state.is_open ?
						{
							is_open: true,
							handleChange: handleChange && handleChange.bind(null, internal_state.mapping_path_position + 1),
							handleClose: handleClose && handleClose.bind(null, internal_state.mapping_path_position + 1),
							automapper_suggestions,
							autoscroll: open_select_element?.autoscroll || false,
							handleAutomapperSuggestionSelection,
						} :
						{
							is_open: false,
							handleOpen: handleOpen && handleOpen.bind(null, internal_state.mapping_path_position + 1),
						}
				),
			}
		),

		commit_instance_data({data}) {
			if (typeof data === 'undefined')
				throw new Error('No data to commit to navigator\'s state');
			internal_state.mapping_line_data.push(data);
			return data;
		},

		get_final_data: () =>
			internal_state.mapping_line_data,
	};

	return navigator<MappingElementProps>({
		callbacks,
		config: {
			base_table_name: base_table_name,
		},
	});

}