/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable, DisposableStore } from 'vs/base/common/lifecycle';
import { IEditorHoverRenderContext } from 'vs/editor/contrib/hover/browser/hoverTypes';
import { ContentWidgetPositionPreference, ICodeEditor, IContentWidget, IContentWidgetPosition } from 'vs/editor/browser/editorBrowser';
import { PositionAffinity } from 'vs/editor/common/model';
import { Position } from 'vs/editor/common/core/position';
import { ColorHover, StandaloneColorPickerParticipant } from 'vs/editor/contrib/colorPicker/browser/colorHoverParticipant';
import { IInstantiationService } from 'vs/platform/instantiation/common/instantiation';
import { EditorHoverStatusBar } from 'vs/editor/contrib/hover/browser/contentHover';
import { IKeybindingService } from 'vs/platform/keybinding/common/keybinding';
import { ColorPickerWidget, InsertButton } from 'vs/editor/contrib/colorPicker/browser/colorPickerWidget';
import { Emitter } from 'vs/base/common/event';
import { EditorOption } from 'vs/editor/common/config/editorOptions';
import { IColorInformation } from 'vs/editor/common/languages';
import { ILanguageFeaturesService } from 'vs/editor/common/services/languageFeatures';
import { IEditorContribution } from 'vs/editor/common/editorCommon';
import { EditorContributionInstantiation, registerEditorContribution } from 'vs/editor/browser/editorExtensions';
import { EditorContextKeys } from 'vs/editor/common/editorContextKeys';
import { IContextKey, IContextKeyService } from 'vs/platform/contextkey/common/contextkey';
import { Selection } from 'vs/editor/common/core/selection';
import { IRange } from 'vs/editor/common/core/range';
import { DefaultDocumentColorProviderForStandaloneColorPicker as DefaultDocumentColorProvider } from 'vs/editor/contrib/colorPicker/browser/defaultDocumentColorProvider';
import * as dom from 'vs/base/browser/dom';
import 'vs/css!./colorPicker';

export class StandaloneColorPickerController extends Disposable implements IEditorContribution {

	public static ID = 'editor.contrib.standaloneColorPickerController';
	private _standaloneColorPickerWidget: StandaloneColorPickerWidget | null = null;
	private _standaloneColorPickerVisible: IContextKey<boolean>;
	private _standaloneColorPickerFocused: IContextKey<boolean>;

	constructor(
		private readonly _editor: ICodeEditor,
		@IKeybindingService private readonly _keybindingService: IKeybindingService,
		@IInstantiationService private readonly _instantiationService: IInstantiationService,
		@ILanguageFeaturesService private readonly _languageFeatureService: ILanguageFeaturesService,
		@IContextKeyService private readonly _contextKeyService: IContextKeyService
	) {
		super();
		this._standaloneColorPickerVisible = EditorContextKeys.standaloneColorPickerVisible.bindTo(this._contextKeyService);
		this._standaloneColorPickerFocused = EditorContextKeys.standaloneColorPickerFocused.bindTo(this._contextKeyService);
		// The default document color provider is used mostly for the standalone color picker but can also be used for the default inline color boxes
		this._register(this._languageFeatureService.colorProvider.register('*', new DefaultDocumentColorProvider()));
	}

	public showOrFocus() {
		if (!this._editor.hasModel()) {
			return;
		}
		if (!this._standaloneColorPickerVisible.get()) {
			this._standaloneColorPickerVisible.set(true);
			this._standaloneColorPickerWidget = new StandaloneColorPickerWidget(this._editor, this._standaloneColorPickerVisible, this._standaloneColorPickerFocused, this._instantiationService, this._keybindingService, this._languageFeatureService);
			this._editor.addContentWidget(this._standaloneColorPickerWidget);
		} else if (!this._standaloneColorPickerFocused.get()) {
			this._standaloneColorPickerFocused.set(true);
			this._standaloneColorPickerWidget?.focus();
		}
	}

	public hide() {
		this._standaloneColorPickerFocused.set(false);
		this._standaloneColorPickerVisible.set(false);
		this._standaloneColorPickerWidget?.hide();
		this._editor.focus();
	}

	public insertColor() {
		this._standaloneColorPickerWidget?.updateEditor();
		this.hide();
	}

	public static get(editor: ICodeEditor) {
		return editor.getContribution<StandaloneColorPickerController>(StandaloneColorPickerController.ID);
	}
}

registerEditorContribution(StandaloneColorPickerController.ID, StandaloneColorPickerController, EditorContributionInstantiation.AfterFirstRender);

export class StandaloneColorPickerWidget implements IContentWidget {

	static readonly ID = 'editor.contrib.standaloneColorPickerWidget';
	private body: HTMLElement = document.createElement('div');

	private readonly _position: Position | undefined = undefined;
	private readonly _selection: Selection | null = null;
	private readonly _participant: StandaloneColorPickerParticipant;
	private readonly _standaloneColorPickerComputer: StandaloneColorPickerComputer;

	private _disposables: DisposableStore = new DisposableStore();
	private _colorHoverData: ColorHover | null = null;
	private _selectionSetInEditor: boolean = false;

	constructor(
		private readonly editor: ICodeEditor,
		private readonly _standaloneColorPickerVisible: IContextKey<boolean>,
		private readonly _standaloneColorPickerFocused: IContextKey<boolean>,
		@IInstantiationService private readonly instantiationService: IInstantiationService,
		@IKeybindingService private readonly keybindingService: IKeybindingService,
		@ILanguageFeaturesService private readonly languageFeaturesService: ILanguageFeaturesService
	) {

		this._position = this.editor._getViewModel()?.getPrimaryCursorState().viewState.position;
		this._selection = this.editor.getSelection();
		const selection = this._selection ?
			{
				startLineNumber: this._selection.startLineNumber,
				startColumn: this._selection.startColumn,
				endLineNumber: this._selection.endLineNumber,
				endColumn: this._selection.endColumn
			} : { startLineNumber: 0, endLineNumber: 0, endColumn: 0, startColumn: 0 };
		this._participant = this.instantiationService.createInstance(StandaloneColorPickerParticipant, this.editor);
		const focusTracker = this._disposables.add(dom.trackFocus(this.body));
		this._standaloneColorPickerComputer = new StandaloneColorPickerComputer(selection, this.editor, this._participant, this.languageFeaturesService);
		this._disposables.add(this._standaloneColorPickerComputer.onResult((result) => {
			this._render(result.value, result.foundInMap);
		}));
		// When the cursor position changes, hide the color picker
		this._disposables.add(this.editor.onDidChangeCursorPosition(() => {
			// Except when the cursor changes position because the selection is changed when the keybindings are used to make the color picker appear
			if (!this._selectionSetInEditor) {
				this.hide();
			} else {
				this._selectionSetInEditor = false;
			}
		}));
		this._disposables.add(focusTracker.onDidBlur(_ => {
			this.hide();
		}));
		this._disposables.add(focusTracker.onDidFocus(_ => {
			this.focus();
		}));
		this._standaloneColorPickerComputer.start();
	}

	public updateEditor() {
		if (this._colorHoverData) {
			this._participant.updateEditorModel([this._colorHoverData]);
		}
	}

	private _render(colorHoverData: ColorHover, foundInEditor: boolean) {

		const fragment = document.createDocumentFragment();
		const statusBar = this._disposables.add(new EditorHoverStatusBar(this.keybindingService));
		let colorPickerWidget: ColorPickerWidget | undefined;

		const context: IEditorHoverRenderContext = {
			fragment,
			statusBar,
			setColorPicker: (widget: ColorPickerWidget) => colorPickerWidget = widget,
			onContentsChanged: () => { },
			hide: () => this.hide()
		};

		this._colorHoverData = colorHoverData;
		this._disposables.add(this._participant.renderHoverParts(context, [colorHoverData]));

		if (colorPickerWidget === undefined) {
			return;
		}

		this.body.classList.add('standalone-color-picker-body');
		this.body.style.maxHeight = Math.max(this.editor.getLayoutInfo().height / 4, 250) + 'px';
		this.body.style.maxWidth = Math.max(this.editor.getLayoutInfo().width * 0.66, 500) + 'px';
		this.body.tabIndex = 0;
		this.body.appendChild(fragment);
		colorPickerWidget.layout();

		const enterButton: InsertButton | null = colorPickerWidget.body.enterButton;
		enterButton?.onClicked(() => {
			this.updateEditor();
			this.hide();
		});
		const closeButton = colorPickerWidget.header.closeButton;
		closeButton?.onClicked(() => {
			this.hide();
		});

		// When found in the editor, we want to highlight the selection in the editor
		if (foundInEditor) {
			if (enterButton) {
				enterButton.button.textContent = 'Replace';
			}
			this._selectionSetInEditor = true;
			this.editor.setSelection(colorHoverData.range);
		}
		this.editor.layoutContentWidget(this);
	}

	public getId(): string {
		return StandaloneColorPickerWidget.ID;
	}

	public getDomNode(): HTMLElement {
		return this.body;
	}

	public getPosition(): IContentWidgetPosition | null {
		if (!this._position) {
			return null;
		}
		const positionPreference = this.editor.getOption(EditorOption.hover).above;
		return {
			position: this._position,
			secondaryPosition: this._position,
			preference: positionPreference ? [ContentWidgetPositionPreference.ABOVE, ContentWidgetPositionPreference.BELOW] : [ContentWidgetPositionPreference.BELOW, ContentWidgetPositionPreference.ABOVE],
			positionAffinity: PositionAffinity.None
		};
	}

	public hide(): void {
		this.editor.removeContentWidget(this);
		this._disposables.dispose();
		this._standaloneColorPickerVisible.set(false);
		this._standaloneColorPickerFocused.set(false);
		this.editor.focus();
	}

	public focus(): void {
		this.body.focus();
	}
}

export class StandaloneColorPickerResult {
	// The color picker result consists of: n array of color results and a boolean indicating if the color was found in the editor
	constructor(
		public readonly value: ColorHover,
		public readonly foundInMap: boolean
	) { }
}

export interface IStandaloneColorPickerComputer {
	start(): Promise<void>;
}

export class StandaloneColorPickerComputer extends Disposable implements IStandaloneColorPickerComputer {

	private readonly _onResult = this._register(new Emitter<StandaloneColorPickerResult>());
	public readonly onResult = this._onResult.event;

	constructor(
		private readonly _range: IRange,
		private readonly _editor: ICodeEditor,
		private readonly _participant: StandaloneColorPickerParticipant,
		@ILanguageFeaturesService private readonly languageFeaturesService: ILanguageFeaturesService,
	) {
		super();
	}

	public async start(): Promise<void> {
		if (this._range !== null) {
			const computeAsyncResult = await this.computeAsync(this._range);
			if (!computeAsyncResult) {
				return;
			}
			this._onResult.fire(new StandaloneColorPickerResult(computeAsyncResult.result, computeAsyncResult.foundInEditor));
		}
	}

	private async computeAsync(range: IRange): Promise<{ result: ColorHover; foundInEditor: boolean } | null> {
		if (!this._editor.hasModel()) {
			return null;
		}
		const colorInfo: IColorInformation = {
			range: range,
			color: { red: 0, green: 0, blue: 0, alpha: 1 }
		};
		const textModel = this._editor.getModel();
		const providers = this.languageFeaturesService.colorProvider.ordered(textModel).reverse();
		const createColorHoverResult: { colorHover: ColorHover; foundInMap: boolean } | null = await this._participant.createColorHover(colorInfo, providers[0]);
		if (!createColorHoverResult) {
			return null;
		}
		const colorHover = createColorHoverResult.colorHover;
		const foundInEditor = createColorHoverResult.foundInMap;
		return { result: colorHover, foundInEditor: foundInEditor };
	}

	public override dispose(): void {
		super.dispose();
	}
}