/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

'use strict';

import nls = require('vs/nls');

import 'vs/base/common/async';
import 'vs/base/node/stdFork';
import 'vs/languages/lib/common/wireProtocol';

import pfs = require('vs/base/node/pfs');

import URI from 'vs/base/common/uri';
import {TPromise} from 'vs/base/common/winjs.base';
import json = require('vs/base/common/json');
import strings = require('vs/base/common/strings');
import paths = require('vs/base/common/paths');
import {IPluginService, IPluginDescription, IMessage} from 'vs/platform/plugins/common/plugins';
import {PluginsRegistry, PluginsMessageCollector, IPluginsMessageCollector} from 'vs/platform/plugins/common/pluginsRegistry';
import {PluginHostAPIImplementation} from 'vs/workbench/api/browser/pluginHost.api.impl';
import { create as createIPC, IPluginsIPC } from 'vs/platform/plugins/common/ipcRemoteCom';
import {PluginHostModelService} from 'vs/workbench/api/common/pluginHostDocuments';
import {IInstantiationService } from 'vs/platform/instantiation/common/instantiation';
import InstantiationService = require('vs/platform/instantiation/common/instantiationService');
import {PluginHostPluginService} from 'vs/platform/plugins/common/nativePluginService';
import {PluginHostThreadService} from 'vs/platform/thread/common/pluginHostThreadService';
import marshalling = require('vs/base/common/marshalling');
import {PluginHostTelemetryService} from 'vs/workbench/api/common/pluginHostTelemetry';
import {BaseRequestService} from 'vs/platform/request/common/baseRequestService';
import {BaseWorkspaceContextService} from 'vs/platform/workspace/common/baseWorkspaceContextService';
import {ModeServiceImpl} from 'vs/editor/common/services/modeServiceImpl';
import {IThemeExtensionPoint} from 'vs/platform/theme/common/themeExtensionPoint';
import {ILanguageExtensionPoint} from 'vs/editor/common/modes/languageExtensionPoint';
import {ITMSyntaxExtensionPoint} from 'vs/editor/node/textMate/TMSyntax';
import {PluginScanner} from 'vs/workbench/node/extensionPoints';
import Severity from 'vs/base/common/severity';
import { IWorkspaceContextService } from 'vs/platform/workspace/common/workspace';
import { Client } from 'vs/base/node/service.net';
import { IExtensionsService } from 'vs/workbench/parts/extensions/common/extensions';
import { ExtensionsService } from 'vs/workbench/parts/extensions/node/extensionsService';

const DIRNAME = URI.parse(require.toUrl('./')).fsPath;
const BASE_PATH = paths.normalize(paths.join(DIRNAME, '../../../..'));
const BUILTIN_PLUGINS_PATH = paths.join(BASE_PATH, 'extensions');

export interface IInitData {
	threadService: any;
	contextService: {
		workspace: any;
		configuration: any;
		options: any;
	};
}

const nativeExit = process.exit.bind(process);
process.exit = function() {
	const err = new Error('An extension called process.exit() and this was prevented.');
	console.warn((<any>err).stack);
};
export function exit(code?: number) {
	nativeExit(code);
}

export function createServices(remoteCom: IPluginsIPC, initData: IInitData, sharedProcessClient: Client): IInstantiationService {
	// the init data is not demarshalled
	initData = marshalling.deserialize(initData);

	let contextService = new BaseWorkspaceContextService(initData.contextService.workspace, initData.contextService.configuration, initData.contextService.options);
	let threadService = new PluginHostThreadService(remoteCom);
	threadService.setInstantiationService(InstantiationService.create({ threadService: threadService }));
	let telemetryServiceInstance = new PluginHostTelemetryService(threadService);
	let requestService = new BaseRequestService(contextService, telemetryServiceInstance);
	let modelService = threadService.getRemotable(PluginHostModelService);

	let pluginService = new PluginHostPluginService(threadService);
	let modeService = new ModeServiceImpl(threadService, pluginService);
	let _services: any = {
		contextService: contextService,
		requestService: requestService,
		modelService: modelService,
		threadService: threadService,
		modeService: modeService,
		pluginService: pluginService,
		telemetryService: PluginHostTelemetryService
	};
	let instantiationService = InstantiationService.create(_services);
	threadService.setInstantiationService(instantiationService);

	// Create the monaco API
	instantiationService.createInstance(PluginHostAPIImplementation);

	// Connect to shared process services
	instantiationService.addSingleton(IExtensionsService, sharedProcessClient.getService<IExtensionsService>('ExtensionService', ExtensionsService));

	return instantiationService;
}

interface ITestRunner {
	run(testsRoot:string, clb: (error:Error, failures?: number) => void): void;
}

export class PluginHostMain {

	constructor(
		@IWorkspaceContextService private contextService: IWorkspaceContextService,
		@IPluginService private pluginService: IPluginService,
		@IInstantiationService instantiationService: IInstantiationService
	) {}

	public start(): TPromise<void> {
		return this.readPlugins();
	}

	private readPlugins(): TPromise<void> {
		let collector = new PluginsMessageCollector();
		let env = this.contextService.getConfiguration().env;

		return PluginHostMain.scanPlugins(collector, BUILTIN_PLUGINS_PATH, env.userPluginsHome, env.pluginDevelopmentPath, env.version)
			.then(null, err => {
				collector.error('', err);
				return [];
			})
			.then(extensions => {
				// Register & Signal done
				PluginsRegistry.registerPlugins(extensions);
				this.pluginService.registrationDone(collector.getMessages());
			})
			.then(() => this.handleEagerPlugins())
			.then(() => this.handlePluginTests());
	}

	private static scanPlugins(collector: IPluginsMessageCollector, builtinPluginsPath: string, userInstallPath: string, pluginDevelopmentPath: string, version: string): TPromise<IPluginDescription[]> {

		let builtinPlugins: TPromise<IPluginDescription[]> = PluginScanner.scanPlugins(version, collector, builtinPluginsPath, true);
		let userPlugins: TPromise<IPluginDescription[]> = (userInstallPath ? PluginScanner.scanPlugins(version, collector, userInstallPath, false) : TPromise.as([]));
		let developedPlugins: TPromise<IPluginDescription[]> = (pluginDevelopmentPath ? PluginScanner.scanOneOrMultiplePlugins(version, collector, pluginDevelopmentPath, false) : TPromise.as([]));

		return TPromise.join([builtinPlugins, userPlugins, developedPlugins]).then((_: IPluginDescription[][]) => {
			let builtinPlugins = _[0];
			let userPlugins = _[1];
			let extensionDevPlugins = _[2];

			let resultingPluginsMap: { [pluginName: string]: IPluginDescription; } = {};
			builtinPlugins.forEach((builtinPlugin) => {
				resultingPluginsMap[builtinPlugin.id] = builtinPlugin;
			});
			userPlugins.forEach((userPlugin) => {
				if (resultingPluginsMap.hasOwnProperty(userPlugin.id)) {
					collector.warn('', 'Overwriting extension ' + resultingPluginsMap[userPlugin.id].extensionFolderPath + ' with ' + userPlugin.extensionFolderPath);
				}
				resultingPluginsMap[userPlugin.id] = userPlugin;
			});
			extensionDevPlugins.forEach(extensionDevPlugin => {
				collector.info('', 'Loading development extension at ' + extensionDevPlugin.extensionFolderPath);
				if (resultingPluginsMap.hasOwnProperty(extensionDevPlugin.id)) {
					collector.warn('', 'Overwriting extension ' + resultingPluginsMap[extensionDevPlugin.id].extensionFolderPath + ' with ' + extensionDevPlugin.extensionFolderPath);
				}
				resultingPluginsMap[extensionDevPlugin.id] = extensionDevPlugin;
			});

			return Object.keys(resultingPluginsMap).map(name => resultingPluginsMap[name]);
		});
	}

	// Handle "eager" activation plugins
	private handleEagerPlugins(): TPromise<void> {
		this.pluginService.activateByEvent('*').then(null, (err) => {
			console.error(err);
		});
		return this.handleWorkspaceContainsEagerPlugins();
	}

	private handleWorkspaceContainsEagerPlugins(): TPromise<void> {
		let workspace = this.contextService.getWorkspace();
		if (!workspace || !workspace.resource) {
			return TPromise.as(null);
		}

		let folderPath = workspace.resource.fsPath;

		let desiredFilesMap: {
			[filename: string]: boolean;
		} = {};

		PluginsRegistry.getAllPluginDescriptions().forEach((desc) => {
			let activationEvents = desc.activationEvents;
			if (!activationEvents) {
				return;
			}

			for (let i = 0; i < activationEvents.length; i++) {
				if (/^workspaceContains:/.test(activationEvents[i])) {
					let fileName = activationEvents[i].substr('workspaceContains:'.length);
					desiredFilesMap[fileName] = true;
				}
			}
		});

		return TPromise.join(
			Object.keys(desiredFilesMap).map(
				(fileName) => pfs.fileExistsWithResult(paths.join(folderPath, fileName), fileName)
			)
		).then((fileNames: string[]) => {
			fileNames.forEach((existingFileName) => {
				if (!existingFileName) {
					return;
				}

				let activationEvent = 'workspaceContains:' + existingFileName;
				this.pluginService.activateByEvent(activationEvent).then(null, (err) => {
					console.error(err);
				});
			});
		});
	}

	private handlePluginTests(): TPromise<void> {
		let env = this.contextService.getConfiguration().env;
		if (!env.pluginTestsPath || !env.pluginDevelopmentPath) {
			return TPromise.as(null);
		}

		// Require the test runner via node require from the provided path
		let testRunner:ITestRunner;
		let requireError:Error;
		try {
			testRunner = <any>require.__$__nodeRequire(env.pluginTestsPath);
		} catch (error) {
			requireError = error;
		}

		// Execute the runner if it follows our spec
		if (testRunner && typeof testRunner.run === 'function') {
			return new TPromise<void>((c, e) => {
				testRunner.run(env.pluginTestsPath, (error, failures) => {
					if (error) {
						e(error.toString());
					} else {
						c(null);
					}

					// after tests have run, we shutdown the host
					this.gracefulExit(failures && failures > 0 ? 1 /* ERROR */ : 0 /* OK */);
				});
			});
		}

		// Otherwise make sure to shutdown anyway even in case of an error
		else {
			this.gracefulExit(1 /* ERROR */);
		}

		return TPromise.wrapError<void>(requireError ? requireError.toString() : nls.localize('pluginTestError', "Path {0} does not point to a valid extension test runner.", env.pluginTestsPath));
	}

	private gracefulExit(code: number): void {
		// to give the PH process a chance to flush any outstanding console
		// messages to the main process, we delay the exit() by some time
		setTimeout(() => exit(code), 500);
	}
}