"use strict"
if (document.currentScript && document.currentScript.innerText.length) {
	// if the script-tag that inclues the tempate engine 
	// is non-empty that block is evaluated as the initial state
	window.picoroot=eval(`(${document.currentScript.innerText})`);
}

// We delay processing until the document is loaded since we want to process all of it.
window.addEventListener("load",(e)=>{
	// wait one tick additionally incase "user"-code exists that needs to be processed.
	setTimeout((e)=>{

		// private symbols used for objects within the DOM and object state.
		let cleanup = Symbol("cleanup");     // the cleanup property is a no-arg function that will clean up listeners,etc from an object when deleting.
		let proxyFlag = Symbol("proxyflag"); // the proxyflag is used internally to flag if objects are managed already or not.
		let listeners = Symbol("listeners"); // this property within objects should contain a Set object of all listeners that needs wake-up
		let modelBind = Symbol("modelbind"); // the modelbind property is used by the listeners to store binding information. 

		// the dependent object is set to an object with a modelBind property that will auto-register as a listener for all objects that are accessed.
		let dependent = null;
		// run fn with dependent as the listener to get automatic registrations.
		let withDep = (dep,fn) => {
			if (dependent!==null)
				throw new Exception("Multiple-dependent, ",dep,dependent);
			dependent=dep;
			try {
				return fn();
			} finally {
				dependent=null;
			}
		}

		// we create shadow-proxies for scopes within the root tree
		let withShadow = (target,shadow) => {
			return new Proxy(target,{
				has(target,prop) {
					if (Reflect.has(shadow,prop))
						return true;
					return Reflect.has(target,prop);
				},
				get(target,prop,recv){
					if (shadow.hasOwnProperty(prop))
						return shadow[prop];
					return target[prop];
				},
				set(target,prop,value,recv) {
					if (shadow.hasOwnProperty(prop))
						return false;
					return Reflect.set(target,prop,value,recv);
				}
			})
		}

		// register cleanup
		const addCleanup = (node,cmm) =>{
			if (node[cleanup]) {
				// If a node already contains cleanup we make a chain-call
				const old = node[cleanup];
				node[cleanup] = ()=>(cmm(),old());
			} else {
				node[cleanup] = cmm;
			}
			return node;
		}

		// unlink an object from the places it listens at.
		let unlink = node => {
			const mb = node[modelBind];
			mb.dependencies.forEach(dependency=>{
				dependency[listeners].delete(node);
			});
			mb.dependencies.clear();
		}
		// recursivce unlink (usually on DOM tree-nodes)
		let unlinkTree = node => {
			if (node.nodeType && node.nodeType === 1) {
				for (let i = 0; i < node.childNodes.length; i++) {
					unlinkTree(node.childNodes[i]);
				}
				if (node.attributes)
					for (let i = 0; i < node.attributes.length; i++) {
						const att = node.attributes[i];
						if (att[modelBind])
							unlink(att);
					}
			}
			if (node[cleanup])
				node[cleanup]();
			if (node[modelBind])
				unlink(node);
		}
		// call this function to return a proxy to the specified object (if the specified object is already an proxy or "primitive" it's a no-op)
		let proxify = v => {
			if (v===null || v===undefined || v===true || v===false)
				return v;
			if ("number"===typeof v || "string"===typeof v)
				return v;
			if ("function"===typeof v)
				return v;
			if (v instanceof Date)
				return v;
			if (v[proxyFlag]) {
				return v;
			}
			// replace all members/items with proxies
			if (v instanceof Array) {
				for (let i=0;i<v.length;i++) {
					v[i]=proxify(v[i]);
				}
			} else {
				for (let k of Object.keys(v)) {
					v[k]=proxify(v[k]);
				}
			}
			Object.defineProperty(v,listeners,{
				value: new Set()
			});
			return new Proxy(v,proxyDef);
		};
		// the common proxy methods
		let proxyDef = {
			get(target,prop,recv){
				if (prop===proxyFlag)
					return true;
				if (dependent && prop!==listeners) {
					// If we had a dependent, it's registered
					target[listeners].add(dependent);
					dependent[modelBind].dependencies.add(recv);
				}
				return target[prop];
			},
			set(target,prop,value) {
				let ov= target[prop]
				let rv= Reflect.set(target,prop,proxify(value));
				if (ov!==value) {
					schedule(target[listeners]);
				}
				return rv;
			}
		};
		let root = {};
		if ("undefined" !== typeof (window.picoroot) ) {
			root=window.picoroot;
		}
		root = proxify(root);
		Object.defineProperty(window,"picoroot",{
			get() { return root; },
			set(v) { root=proxify(v); } 
		});
		// templating language:
		// p-for = "item in expression"    run for each item
		// p-for = "(item,index) in expr"  run for each item and give the index of the item
		// p-empty = "expression"          shows if empty expression (null/undefined/[])
		// p-if = "expression"             renders if truthy
		// p-model = "expression"          2 way data-binding
		// p-model.number = "expression"   2 way data-binding for numbers
		// p-model.trim   = "expression"   2 way data-binding with text auto-trim
		// :innerText = "expression"       the property should be set to the following expression
		// @event = "handler"              the handler code should be run for the event, the $event arg variable is available.
		// NOT USED/impl: p-tpl = "id"               source template id, only the first occurence of each is stored.
		//                                           text and comments between p-tpl's of the same id are collapsed.
		
		let anchorCount = 0;
		
		let compileExpr = expr => new Function("scope",`with(scope){ return ${ expr }; }`);
		let compileLExpr = expr => {
			let cre = /^(.+)\.(\w+)\s*$/.exec(expr);
			//if (!cre) return null;
			if (!cre)
				return {f:()=>root,p:expr};
			return {f:compileExpr(cre[1]),p:cre[2]};
		}

		// process is the main function that links together or templates the node-tree according to the data-state
		const process = (node,scope)=> {
			// element-node
			if (node.nodeType===1) {
				// does the element have a 2-way input data-binding.
				const att=node.attributes["p-model"]
				if (att) {
					const lexpr = {
						...compileLExpr(att.value),
						dependencies:new Set()
					};
					//console.log(att.value+" evals to "+lexpr.f(scope)[lexpr.p]);
					let iatt;
					const tn = node;
					if ((iatt=tn.attributes["type"]) && iatt.value==="checkbox") {
						lexpr.update = function(){
							unlink(tn);
							const to = lexpr.f(scope);
							withDep(tn,()=>tn.checked = to[lexpr.p]);
						};
						lexpr.onInput = ()=>{
							const to = lexpr.f(scope);
							to[lexpr.p] = tn.checked;
						}
					} else {
						lexpr.update = function(){
							unlink(tn);
							const to = lexpr.f(scope);
							withDep(tn,()=>{
								let v = to[lexpr.p];
								if (v===undefined) v="";
								tn.value = v;
							});
						}
						lexpr.onInput = ()=>{
							const to = lexpr.f(scope);
							to[lexpr.p] = tn.value;
						}
					}
					tn[modelBind]=lexpr;
					lexpr.update();
				}
				for(let i=0;i<node.attributes.length;i++) {
					const att = node.attributes[i];
					if (att.name.startsWith("@")) {
						const evtName = att.name.substring(1);
						const listener = (new Function("scope","$event",`with(scope){ return ${ att.value }; }`)).bind(root,scope);
						node.addEventListener(evtName,listener);
						addCleanup(node,()=>node.removeEventListener(evtName,listener))
					}
					if (att.name.startsWith(":")) {
						const key = att.name.substring(1); 
						const tnod = att;
						const expr = compileExpr(att.value);
						const mb=(tnod[modelBind]={dependencies:new Set(),update:function() {
							unlink(tnod)
							let rt = withDep(tnod,()=>{
								let rt = expr(scope);
								return rt;
							});
							//console.log(`Setting ${key} to ${rt} on `,node);
							node[key]=rt;
						}});
						mb.update();
					}
				}
			}

			for (let curChild=node.firstChild;curChild;curChild=curChild.nextSibling){
				//if (curChild.nodeType===2) {
				//	console.log("Attribute in process?!",curChild);
				//}
				// handle mustache templates within text nodes
				if (curChild.nodeType===3) {
					const tnod = curChild;
					const txt = curChild.textContent;
					let musre = /{{(.+?)}}/g;
					if (musre.exec(txt)) {
						let mb=(tnod[modelBind]={dependencies:new Set(),update:function() {
							unlink(tnod)
							let rt = withDep(tnod,()=>musre[Symbol.replace](txt,(m,g1)=>{
								let expr = compileExpr(g1);
								let rt = expr(scope);
								return rt;
							}));
							// TODO: register for updates..
							rt=String(rt);
							if (rt!=tnod.textContent)
								tnod.textContent=rt;
						}});
						mb.update();
					}					
				}
				if (curChild.nodeType===1) { // nodetype 1 is element
					// All dynamic node mutation is handled in one place
					// - first all p-empty/p-if/p-else-if/p-else nodes are collapsed (and always evaluated first)
					// - secondly any nodes with p-for (conditionally if an condition from above exists) are generated
					//
					// a combined process from the above will generate wanted element-trees that the sync code will then realize

					let forAtt = curChild.attributes["p-for"];
					let emptyAtt = curChild.attributes["p-empty"];
					let ifAtt = curChild.attributes["p-if"];
					let anchor = forAtt || emptyAtt || ifAtt ? document.createComment("picoanchor:"+(anchorCount++)) : null;
					if (anchor) {
						//console.log("Insert anchor before",c);
						node.insertBefore(anchor,curChild);

						const elistHeadChild = curChild;
						let elist = [{c:()=>true,g:()=>[[elistHeadChild]]}]; // eval-list consists of (c)ond/(g)en as {c:()=>bool, g:()=>[wantedProj...]} , wantedProj is [srcNode,scopeKey,scopeValue,scopeKey,scopeValue...]

						// Gather the sequence of if/else-if/else elements (if it's only a for or a single if/empty then that will be the default seq)
						let postSeq = curChild.nextSibling;
						if (ifAtt || emptyAtt) {
							let test = curChild;
							const addCond=(item,att,eMod=(v=>v))=>{
								const prevCond = item.c;
								const expr = att===null?()=>true:compileExpr(att.value);
								item.c = ()=>{
									return eMod(expr(scope)) && prevCond();
								};
								return item;
							}
							// Add initial p-if and p-empty condition code.
							if (ifAtt)
								addCond(elist[0],ifAtt);
							if (emptyAtt)
								addCond(elist[0],emptyAtt,
									lv=>
									lv===undefined||lv===null
									?true
									:(lv instanceof Array)
									?lv.length===0
									:true);
							// now loop and gather p-else-if and p-else elements
							while(true) {
								let eelem;
								let eatt;
								if (eatt=(eelem=test.nextElementSibling).attributes["p-else-if"]) {
									elist.push(addCond({c:()=>true,g:()=>[[eelem]]},eatt))
									test=eelem;
									postSeq = test.nextSibling;
									continue;
								} else if (eatt=(eelem=test.nextElementSibling).attributes["p-else"]) {
									elist.push(addCond({c:()=>true,g:()=>[[eelem]]},null))
									// elist.push({c:.., g:...})
									postSeq = eelem.nextSibling;
									break;
								} else break;
							}
						}

						// replace any gen with for-gen if existing at this point.
						for (let i=0;i<elist.length;i++) {
							const tn = elist[i].g()[0][0];
							const forAtt = tn.attributes["p-for"];
							if (!forAtt)
								continue;

							// this regexp parses "item in expr" or "(item,index) in expr" within the p-for attributes
							const forex = /^\s*(?:(?<id>[a-zA-Z_]\w*)|\(\s*(?<iid>[a-zA-Z_]\w*)\s*,\s*(?<idx>[a-zA-Z_]\w*)\s*\))\s+in\s+(?<expr>.+)$/.exec(forAtt.value);
							if (!forex) {
								console.error("Bad p-for expression:" + forAtt.value);
								continue;
							}
							const idName = forex.groups.id ?? forex.groups.iid;
							const idxName = forex.groups.idx;

							const efn = compileExpr(forex.groups.expr);

							elist[i].g = ()=>{
								let sitems = efn(scope);
								if (!sitems || sitems.length===0)
									return [];
								return sitems.map((item,idx)=>idxName?[tn,idName,item,idxName,idx]:[tn,idName,item]);
							}								
						}

						// after the p-if/p-empty/p-else-if/p-else gathering loop we now know that we don't need any nodes between the anchor and postSeq
						while(anchor.nextSibling!==postSeq && anchor.nextSibling) {
							node.removeChild(anchor.nextSibling);
						}

						// Now attach modelBind update data to the anchor node that handles creation/destruction
						// of sub-nodes depending on conditions AND/OR for loop outputs.
						(anchor[modelBind]={
							update:function () {
								unlink(anchor)

								// run the condition list until one succeeds and generates the wantedNodes set
								let wantedNodes = withDep(anchor,()=>{
									for (let i=0;i<elist.length;i++) {
										let gi = elist[i];
										if (gi.c()) {
											return gi.g();
										}
									}
									return [];
								})

								// node-synchornization is always done from the end-forward (Because we only use insertBefore combined with anchoring)
								let outState=[];
								let outNodes=[];
								let existingNodes = this.prev;
								let existingDomNodes = this.dn;
								let insertPoint = anchor;

								// first process re-uses (and DOM node creations) while we have unhandled "wanted" nodes,
								wLoop: while(wantedNodes.length) {
									const wantedNode = wantedNodes.pop();
									// try to find/reuse an existing node
									for (let i=existingNodes.length-1;i>=0;i--) {
										if (  existingNodes[i].reduce((prev,ev,ii)=>prev && ev===wantedNode[ii],true) ) {
											let on = existingDomNodes[i];
											if (i+1!==existingNodes.length) {
												node.insertBefore(on,insertPoint);
											} else if (insertPoint.previousSibling!==on) {
												 // if we have an failed invariant flag it.
												throw new Error("Inconsistent state!");
											}
											existingDomNodes.splice(i,1);
											existingNodes.splice(i,1);
											insertPoint = on;
											outState.unshift(wantedNode);
											outNodes.unshift(on);
											continue wLoop;
										}
									}
									// no existing matching element found, create a new node.
									{
										//if (existingNodes.length==1)
										//	console.log(wantedNode," replaces ",existingNodes[0])
										let on = wantedNode[0].cloneNode(true); // make a deep clone of the template.
										let shadow = {};
										for (let i=1;i+1<wantedNode.length;i+=2) {
											shadow[wantedNode[i]]=wantedNode[i+1];
										}
										on = process(on,withShadow(scope,shadow));
										node.insertBefore(on,insertPoint);
										insertPoint = on;
										outState.unshift(wantedNode);
										outNodes.unshift(on);
										continue;
									}
								}
								// Everything left in existDomNodes/existingNodes is garbage since the previous loop has synched with wantedNodes
								while(existingDomNodes.length) {
									const delNode = existingDomNodes.pop();
									unlinkTree(delNode);
									node.removeChild(delNode)
								}
								// replace the modelBind data
								this.prev = outState;
								this.dn = outNodes;
							},
							dn:[],    // prev-dom-nodes-list
							prev:[],  // prev-req-state
							dependencies:new Set()
						}).update();

						curChild = anchor;
						continue;
					}

					// for regular nodes, process recursive elements
					process(curChild,scope);
				}
			}
			return node;
		};
				
		// The scheduling functionality will run everything registered on the current tick during the next tick
		let scheduled = null;
		let schedule = a => {
			if (scheduled===null) {
				let mysched = scheduled=new Set;
				setTimeout(()=>{
					if (scheduled==mysched)
						scheduled=null;
					for(let l of mysched) {
						l[modelBind].update();
					}
				},1);
			}
			if (a instanceof Set) {
				a.forEach(v=>scheduled.add(v));
			} else {
				scheduled.add(a);
			}
		};
		
		// We listen to "input" events globally and flag updates on registered nodes only.
		document.addEventListener("input",e=>{
			let lexpr = e.target[modelBind];
			if (!lexpr || !lexpr.onInput) return;
			lexpr.onInput();
		});

		// Finally process the entire document body and auto-register nodes.
		process(document.body,withShadow(root,{"$root":root}));
	},1);
});
