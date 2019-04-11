import { Injectable } from '@angular/core';
import { forkJoin, of } from 'rxjs';
import { catchError } from 'rxjs/operators';

import { SignalKClient } from 'signalk-client-angular';
import { AppInfo } from '../../app.info';
import { GeoUtils, GeoHash } from  '../geoutils'

import { MatDialog } from '@angular/material';
import { AlertDialog, ConfirmDialog, LoginDialog } from '../app-ui';

import { NoteDialog, RegionDialog } from './notes'
import { ResourceDialog } from './resource-dialogs'

// ** Signal K resource operations
@Injectable({ providedIn: 'root' })
export class SKResources {

    private reOpen: {key: any, value: any };

    constructor( public dialog: MatDialog,
        public signalk: SignalKClient, 
        public app: AppInfo) { }


    // **** CHARTS ****

    // ** get charts from sk server
    getCharts() {
        let baseCharts= [
            ['openstreetmap', {
                name: 'World Map',
                description: 'Open Street Map',
                tilemapUrl: null,
                chartUrl: null
            }, true],
            ['openseamap', {
                name: 'Sea Map',
                description: 'Open Sea Map',
                tilemapUrl: null,
                chartUrl: null
            }, true]
        ];

        baseCharts.forEach(i=> {
            i[2]= (this.app.config.selections.charts.indexOf(i[0])==-1) ? false : true;            
        })
        
        this.signalk.api.get('/resources/charts')
        .subscribe( 
            res=> { 
                this.app.data.charts= baseCharts.slice(0); 
                let r= Object.entries(res);
                if(r.length>0) {   
                    // ** sort by name **
                    r.sort( (a,b)=> { return (b[1]['name'] < a[1]['name']) ? 1 : -1 });
                    r.forEach( i=> {
                        if(i[1]['tilemapUrl'][0]=='/' || i[1]['tilemapUrl'].slice(0,4)!='http') { // ** ensure host is in url
                            i[1]['tilemapUrl']= this.app.host + i[1]['tilemapUrl'];
                        }
                        if(!i[1]['scale']) { i[1]['scale']= 250000 }
                        i[1]['name']= (i[1]['identifier'] && i[1]['identifier']!=i[1]['name']) ? 
                             i[1]['identifier'] + ' - ' + i[1]['name'] : i[1]['name'];
                        
                        this.app.data.charts.push([ 
                            i[0], 
                            new SKChart(i[1]),
                            (this.app.config.selections.charts.indexOf(i[0])==-1) ? false : true 
                        ]);
                    });
                    // ** clean up selections
                    this.app.config.selections.charts= this.app.data.charts.map( 
                        i=>{ return (i[2]) ? i[0] : null }
                    ).filter(i=> { return i});
                }               
            },
            err=> { this.app.data.charts= baseCharts.slice(0) }
        )
    }    


    // **** ROUTES ****

    // ** get routes from sk server
    getRoutes() {
        this.signalk.api.get('vessels/self/navigation/courseGreatCircle/activeRoute')
        .subscribe( 
            r=> {
                if(r['href'] && r['href'].value) {
                    let a= r['href'].value.split('/');
                    this.app.data.activeRoute= a[a.length-1];
                }  
                this.retrieveRoutes();      
            },
            e=> { this.retrieveRoutes() }
        );  

    }

    private retrieveRoutes() {
        this.signalk.api.get('/resources/routes')
        .subscribe( res=> {  
            this.app.data.routes= [];
            if(!res) { return }   

            let r= Object.entries(res);
            r.forEach( i=> {
                this.app.data.routes.push([ 
                    i[0], 
                    new SKRoute(i[1]), 
                    (this.app.config.selections.routes.indexOf(i[0])==-1) ? false : true,
                    (i[0]==this.app.data.activeRoute) ? true : false
                ]);
            });
            // ** clean up selections
            let k= Object.keys(res);
            this.app.config.selections.routes= this.app.config.selections.routes.map( i=> {
                return k.indexOf(i)!=-1 ? i : null;
            }).filter(i=> { return i});            
        });
    }

    // ** build and return object containing: SKRoute,  start & end SKWaypoint objects from supplied coordinates
    buildRoute(coordinates):any {
        let rte= new SKRoute();
        let wStart= new SKWaypoint();
        let wEnd= new SKWaypoint();

        let rteUuid= this.signalk.uuid.toSignalK();  
        let wStartUuid= this.signalk.uuid.toSignalK();  
        let wEndUuid= this.signalk.uuid.toSignalK(); 

        rte.feature.geometry.coordinates= coordinates;
        for(let i=0;i<coordinates.length-1;++i) { 
            rte.distance+= GeoUtils.distanceTo(coordinates[i], coordinates[i+1]);
        }
        rte.start= wStartUuid;
        rte.end= wEndUuid;  

        wStart.feature.geometry.coordinates= rte.feature.geometry.coordinates[0];
        wStart.position= { 
            latitude: wStart.feature.geometry.coordinates[1],
            longitude: wStart.feature.geometry.coordinates[0]
        }
        let l= rte.feature.geometry.coordinates.length;
        wEnd.feature.geometry.coordinates= rte.feature.geometry.coordinates[l-1];
        wEnd.position= { 
            latitude: wEnd.feature.geometry.coordinates[1],
            longitude: wEnd.feature.geometry.coordinates[0]
        }        
        return {
            route: [rteUuid, rte],
            wptStart: [rte.start, wStart],
            wptEnd: [rte.end, wEnd]
        }
    }

    // ** create route on server **
    private createRoute(rte:any) {
        this.signalk.api.put(
            `/resources/routes/${rte['route'][0]}`, 
            rte['route'][1]
        ).subscribe( 
            r=>{ 
                this.getRoutes();
                if(r['state']=='COMPLETED') { 
                    this.submitWaypoint(rte['wptStart'][0], rte['wptStart'][1], false);
                    this.submitWaypoint(rte['wptEnd'][0], rte['wptEnd'][1], false);               
                    this.app.debug('SUCCESS: Route updated.');
                    this.app.config.selections.routes.push(rte['route'][0]);
                    this.app.saveConfig();                                
                }
                else { this.showAlert('ERROR:', 'Server could not add Route!') }
                },
            err=> { 
                //this.getRoutes();
                if(err.status && err.status==401) { 
                    this.showAuth().subscribe( res=> {
                        if(res.cancel) { this.authResult(false) }
                        else { // ** authenticate
                            this.signalk.login(res.user, res.pwd).subscribe(
                                r=> {   // ** authenticated
                                    this.authResult(true, r['token']);
                                    this.createRoute(rte);
                                },
                                err=> {   // ** auth failed
                                    this.authResult(false);
                                    this.showAuth();
                                }
                            );
                        }
                    });
                }
                else { this.showAlert('ERROR:', 'Server could not add Route!') }
            }
        );
    }

    // ** update route on server **
    private updateRoute(id:string, rte:any) {
        this.signalk.api.put(`/resources/routes/${id}`, rte)
        .subscribe( 
            r=>{ 
                this.getRoutes();
                if(r['state']=='COMPLETED') { this.app.debug('SUCCESS: Route updated.') }
                else { this.showAlert('ERROR:', 'Server could not update Route details!') }
            },
            err=> { 
                this.getRoutes();
                if(err.status && err.status==401) { 
                    this.showAuth().subscribe( res=> {
                        if(res.cancel) { this.authResult(false) }
                        else { // ** authenticate
                            this.signalk.login(res.user, res.pwd).subscribe(
                                r=> {   // ** authenticated
                                    this.authResult(true, r['token']);
                                    this.updateRoute(id, rte);
                                },
                                err=> {   // ** auth failed
                                    this.authResult(false);
                                    this.showAuth();
                                }
                            );
                        }
                    });
                } 
                else { this.showAlert('ERROR:', 'Server could not update Route details!') }
            }
        );
    }    

    // ** delete route on server **
    private deleteRoute(id:string) {
        this.signalk.api.delete(`/resources/routes/${id}`)
        .subscribe( 
            r=> {  
                this.getRoutes();
                this.getWaypoints();
                if(r['state']=='COMPLETED') { this.app.debug('SUCCESS: Route deleted.') }
                else { this.showAlert('ERROR:', 'Server could not delete Route!') }                            
            },
            err=> { 
                if(err.status && err.status==401) { 
                    this.showAuth().subscribe( res=> {
                        if(res.cancel) { this.authResult(false) }
                        else { // ** authenticate
                            this.signalk.login(res.user, res.pwd).subscribe(
                                r=> {   // ** authenticated
                                    this.authResult(true, r['token']);
                                    this.deleteRoute(id);
                                },
                                err=> {   // ** auth failed
                                    this.authResult(false);
                                    this.showAuth();
                                }
                            );
                        }
                    });
                } 
                else { this.showAlert('ERROR:', 'Server could not delete Route!') }
            }
        );  
    }   

    // ** Display Edit Route properties Dialog **
    showRouteInfo(e:any) {
        let t= this.app.data.routes.filter( i=>{ if(i[0]==e.id) return true });
        if(t.length==0) { return }
        let rte=t[0][1];
        let resId= t[0][0];

        this.dialog.open(ResourceDialog, {
            disableClose: true,
            data: {
                title: 'Route Details:',
                name: (rte['name']) ? rte['name'] : null,
                comment: (rte['description']) ? rte['description'] : null,
                type: 'route'
            }
        }).afterClosed().subscribe( r=> {
            if(r.result) { // ** save / update route **
                rte['description']= r.data.comment;
                rte['name']= r.data.name;
                this.updateRoute(resId, rte);
            }
        });
    }

    // ** Display New Route properties Dialog **
    showRouteNew(e:any) {
        if(!e.coordinates) { return }    
        let res= this.buildRoute(e.coordinates);
        
        this.dialog.open(ResourceDialog, {
            disableClose: true,
            data: {
                title: 'New Route:',
                name: null,
                comment: null,
                type: 'route',
                addMode: true
            }
        }).afterClosed().subscribe( r=> {
            if(r.result) { // ** create route **
                res['route'][1]['description']= r.data.comment || '';
                res['route'][1]['name']= r.data.name;
                this.createRoute(res);
            }
        });
    }

    // ** Confirm Route Deletion **
    showRouteDelete(e:any) { 
        this.dialog.open(ConfirmDialog, {
            disableClose: true,
            data: {
                message: 'Do you want to delete this Route?\n \nRoute will be removed from the server (if configured to permit this operation).',
                title: 'Delete Route:',
                button1Text: 'YES',
                button2Text: 'NO'
            }
        }).afterClosed().subscribe( ok=> {
            if(ok) { this.deleteRoute(e.id) }
        });          
    }    

    // ** set activeRoute.href, startTime and nextPoint.position **
    activateRoute(id:string, startPoint:any) { 
        let dt= new Date();    
        this.signalk.api.put(
            'self', 
            'navigation/courseGreatCircle/activeRoute/href', 
            `/resources/routes/${id}`
        )
        .subscribe( 
            r=> {
                this.signalk.api.put(
                    'self', 
                    'navigation/courseGreatCircle/activeRoute/startTime', 
                    dt.toISOString()
                )
                .subscribe( 
                    r=> { 
                        this.app.debug('Route activated');
                        this.signalk.api.put('self', 
                            'navigation/courseGreatCircle/nextPoint/position', 
                            startPoint
                        ).subscribe( r=> { this.app.debug('nextPoint set') } );                            

                    },
                    err=> { this.showAlert('ERROR:', 'Server could not Activate Route!') }
                );
            },
            err=> { 
                if(err.status && err.status==401) { 
                    this.showAuth().subscribe( res=> {
                        if(res.cancel) { this.authResult(false) }
                        else { // ** authenticate
                            this.signalk.login(res.user, res.pwd).subscribe(
                                r=> {   // ** authenticated
                                    this.authResult(true, r['token']);
                                    this.activateRoute(id, startPoint);
                                },
                                err=> {   // ** auth failed
                                    this.authResult(false);
                                    this.showAuth();
                                }
                            );
                        }
                    });
                }  
                else { this.showAlert('ERROR:', 'Server could not Activate Route!') }
            }
        );
    }   

    // ** clear activeRoute.href, startTime and nextPoint.position **
    clearActiveRoute() { 
        this.signalk.api.put('self', 'navigation/courseGreatCircle/activeRoute/href', null)
        .subscribe( 
            r=> { 
                this.app.debug('Active Route cleared');
                this.signalk.api.put('self', 'navigation/courseGreatCircle/nextPoint/position', null)
                .subscribe( r=> { this.app.debug('nextPont cleared') } );               
            },
            err=> { 
                if(err.status && err.status==401) { 
                    this.showAuth().subscribe( res=> {
                        if(res.cancel) { this.authResult(false) }
                        else { // ** authenticate
                            this.signalk.login(res.user, res.pwd).subscribe(
                                r=> {   // ** authenticated
                                    this.authResult(true, r['token']);
                                    this.clearActiveRoute();
                                },
                                err=> {   // ** auth failed
                                    this.authResult(false);
                                    this.showAuth();
                                }
                            );
                        }
                    });
                }   
                else { this.showAlert('ERROR:', 'Server could not clear Active Route!') }
            }
        );
    }      
    
    // ** nextPoint.position **
    setNextPoint(position:any) {
        this.signalk.api.put('self', 
            'navigation/courseGreatCircle/nextPoint/position', 
            position
        ).subscribe( 
            r=> { this.app.debug('nextPoint set') },
            err=> { 
                if(err.status && err.status==401) { 
                    this.showAuth().subscribe( res=> {
                        if(res.cancel) { this.authResult(false) }
                        else { // ** authenticate
                            this.signalk.login(res.user, res.pwd).subscribe(
                                r=> {   // ** authenticated
                                    this.authResult(true, r['token']);
                                    this.setNextPoint(position);
                                },
                                err=> {   // ** auth failed
                                    this.authResult(false);
                                    this.showAuth();
                                }
                            );
                        }
                    });
                } 
                else { this.app.debug(err) }
            }
        );      
    }    

    // **** WAYPOINTS ****

    // ** build and return SKWaypoint object with supplied coordinates
    buildWaypoint(coordinates):any {
        let wpt= new SKWaypoint();
        let wptUuid= this.signalk.uuid.toSignalK();  

        wpt.feature.geometry.coordinates= coordinates;
        wpt.position= { 
            latitude: coordinates[1],
            longitude: coordinates[0]
        }        
        return [wptUuid, wpt];
    }    

    // ** get waypoints from sk server
    getWaypoints() {
        this.signalk.api.get('/resources/waypoints')
        .subscribe( 
            res=> { 
                this.app.data.waypoints= [];
                if(!res) { return }                   
                let r= Object.entries(res);

                r.forEach( i=> {
                    if(!i[1]['feature'].properties.name) { 
                        i[1]['feature'].properties.name='Wpt-' + i[0].slice(-6);
                    }
                    this.app.data.waypoints.push([ 
                        i[0], 
                        new SKWaypoint(i[1]), 
                        (this.app.config.selections.waypoints.indexOf(i[0])==-1) ? false : true  
                    ]);
                });
                // ** clean up selections
                let k= Object.keys(res);
                this.app.config.selections.waypoints= this.app.config.selections.waypoints.map( i=> {
                    return k.indexOf(i)!=-1 ? i : null;
                }).filter(i=> { return i});
            },
            err=> {}
        )
    }        
    
    // ** create / update waypoint on server **
    private submitWaypoint(id:string, wpt:SKWaypoint, isNew=false) {
        this.signalk.api.put(`/resources/waypoints/${id}`, wpt).subscribe( 
            r=> { 
                if(r['state']=='COMPLETED') { 
                    this.app.debug('SUCCESS: Waypoint updated.');
                    if(isNew) { 
                        this.app.config.selections.waypoints.push(id);
                        this.app.saveConfig();
                    }
                    this.getWaypoints();
                }
                else { 
                    this.getWaypoints();
                    this.showAlert('ERROR:', 'Server could not update Waypoint details!');
                }
            },
            err=> { 
                this.getWaypoints();
                if(err.status && err.status==401) { 
                    this.showAuth().subscribe( res=> {
                        if(res.cancel) { this.authResult(false) }
                        else { // ** authenticate
                            this.signalk.login(res.user, res.pwd).subscribe(
                                r=> {   // ** authenticated
                                    this.authResult(true, r['token']);
                                    this.submitWaypoint(id, wpt, isNew);
                                },
                                err=> {   // ** auth failed
                                    this.authResult(false);
                                    this.showAuth();
                                }
                            );
                        }
                    });
                }  
                else { this.showAlert('ERROR:', 'Server could not update Waypoint details!') }
            }
        );
    }   

    // ** delete waypoint on server **
    private deleteWaypoint(id:string) {
        this.signalk.api.delete(`/resources/waypoints/${id}`)
        .subscribe( 
            r=> {  
                this.getWaypoints();
                if(r['state']=='COMPLETED') { this.app.debug('SUCCESS: Waypoint deleted.') }
                else { this.showAlert('ERROR:', 'Server could not delete Waypoint!') }                            
            },
            err=> { 
                if(err.status && err.status==401) { 
                    this.showAuth().subscribe( res=> {
                        if(res.cancel) { this.authResult(false) }
                        else { // ** authenticate
                            this.signalk.login(res.user, res.pwd).subscribe(
                                r=> {   // ** authenticated
                                    this.authResult(true, r['token']);
                                    this.deleteWaypoint(id);
                                },
                                err=> {   // ** auth failed
                                    this.authResult(false);
                                    this.showAuth();
                                }
                            );
                        }
                    });
                } 
                else { this.showAlert('ERROR:', 'Server could not delete Waypoint!') }
            }
        );        
    }

    // ** Display waypoint properties Dialog **
    showWaypointEditor(e:any=null, position:[number,number]=null) {      
        let resId= null; 
        let title: string;
        let wpt: SKWaypoint;
        let addMode: boolean=true;

        if(!e) {    // ** add at vessel location
            if(!position) { return }
            wpt= new SKWaypoint(); 
            wpt.feature.geometry.coordinates= position;
            wpt.position.latitude= position[1];
            wpt.position.longitude= position[0];    
            title= 'New waypoint:';      
            wpt.feature.properties['name']= '';
            wpt.feature.properties['cmt']= '';
        }
        else if(!e.id && e.position) { // add at provided position
            wpt= new SKWaypoint(); 
            wpt.feature.geometry.coordinates= e.position;
            wpt.position.latitude= e.position[1];
            wpt.position.longitude= e.position[0];    
            title= 'Drop waypoint:';      
            wpt.feature.properties['name']= '';
            wpt.feature.properties['cmt']= '';
        }
        else { // Edit waypoint details
            resId= e.id;
            title= 'Waypoint Details:'; 
            let w= this.app.data.waypoints.filter( i=>{ if(i[0]==resId) return true });
            if(w.length==0) { return }
            wpt=w[0][1];
            addMode=false;
        }

        this.dialog.open(ResourceDialog, {
            disableClose: true,
            data: {
                title: title,
                name: (wpt.feature.properties['name']) ? wpt.feature.properties['name'] : null,
                comment: (wpt.feature.properties['cmt']) ? wpt.feature.properties['cmt'] : null,
                position: wpt.feature.geometry['coordinates'],
                addMode: addMode
            }
        }).afterClosed().subscribe( r=> {
            wpt.feature.properties['cmt']= r.data.comment || '';
            wpt.feature.properties['name']= r.data.name || '';            
            if(r.result) { // ** save / update waypoint **
                let isNew= false;
                if(!resId) { // add
                    resId= this.signalk.uuid.toSignalK();
                    isNew= true
                }
                this.submitWaypoint(resId, wpt, isNew);
            }
        });
    }    

    // ** Confirm Waypoint Deletion **
    showWaypointDelete(e:any) { 
        this.dialog.open(ConfirmDialog, {
            disableClose: true,
            data: {
                message: 'Do you want to delete this Waypoint?\nNote: Waypoint may be the Start or End of a route so proceed with care!\n \nWaypoint will be removed from the server (if configured to permit this operation).',
                title: 'Delete Waypoint:',
                button1Text: 'YES',
                button2Text: 'NO'
            }
        }).afterClosed().subscribe( ok=> {
            if(ok) { this.deleteWaypoint(e.id) }
        });          
    }

  
    // **** REGIONS ****

    // get regions from server
    getRegions(params:string=null) { 
        let rf= (params && params[0]!='?') ? `?${params}` : ''
        return this.signalk.api.get(`/resources/regions${rf}`);
    }

    // ** create Region and optionally add note **
    private createRegion(region:any, note?:any) {
        this.signalk.api.put( 
            `/resources/regions/${region.id}`,
            region.data
        ).subscribe( 
            res=>{ 
                if(res['state']=='COMPLETED') { 
                    if(note) { this.createNote(note) }
                }
                else { this.showAlert('ERROR:', 'Server could not add Region!') }
            },
            err=> { 
                if(err.status && err.status==401) { 
                    this.showAuth().subscribe( res=> {
                        if(res.cancel) { this.authResult(false) }
                        else { // ** authenticate
                            this.signalk.login(res.user, res.pwd).subscribe(
                                r=> {   // ** authenticated
                                    this.authResult(true, r['token']);
                                    this.createRegion(region, note);
                                },
                                err=> {   // ** auth failed
                                    this.authResult(false);
                                    this.showAuth();
                                }
                            );
                        }
                    });
                }
                else { this.showAlert('ERROR:', 'Server could not add Region!') }
            }
        );        
    }    


    // **** NOTES ****

    // ** get notes / regions from sk server
    getNotes(params:string=null) {
        let resRegions= this.getRegions(params).pipe( catchError(error => of(error)) );

        let rf= (params) ? params : this.app.config.resources.notes.rootFilter;
        rf= this.processTokens(rf);
        if(rf && rf[0]!='?') { rf='?' + rf }
        let resNotes= this.signalk.api.get(`/resources/notes${rf}`);
        let res= forkJoin(resRegions, resNotes);
        res.subscribe(
            res=> { 
                if(typeof res[0]['error']==='undefined') { 
                    let r= Object.entries(res[0]);
                    this.app.data.regions= []; 
                    r.forEach( i=> { this.app.data.regions.push([i[0], new SKRegion(i[1]), false]) });
                }   
                this.app.data.notes= this.processNotes(res[1], true, 300);
            }
        );
    } 

    /* returns array of SKNotes 
        noDesc: true= remove description value
        maxCount: max number of entries to return
    */
    private processNotes(n:any, noDesc:boolean=false, maxCount?:number) {
        let r= Object.entries(n);
        let notes= [];
        // ** set an upper limit of records to process **
        if(maxCount && r.length>maxCount) { r= r.slice(0, maxCount-1) }
        r.forEach( i=> {
            if(noDesc) { i[1]['description']= null }
            if(!i[1]['title']) { 
                i[1]['feature'].properties.title='Note-' + i[0].slice(-6);
            }
            if(typeof i[1]['position']=='undefined') {
                if(typeof i[1]['geohash']!=='undefined') {  // get center of geohash
                    let gh= new GeoHash()
                    let p= gh.center( i[1]['geohash'] );
                    i[1]['position']= {latitude:p[1], longitude:p[0]} 
                }
                else if(typeof i[1]['region']!=='undefined') { // get center of region 
                    let ra= this.app.data.regions.filter( j=> { 
                        if(j[0]==i[1]['region']) { return true }
                    });
                    if(ra.length!=0) {
                        let r= ra[0][1];
                        let c= GeoUtils.centreOfPolygon(r.feature.geometry.coordinates[0]);
                        i[1]['position']= {latitude: c[1], longitude: c[0]};
                    }
                }            
            }
            if( typeof i[1]['position']!== 'undefined') { 
                notes.push([ i[0], new SKNote(i[1]), true ]);
            }
        });
        return notes;
    }    
    
    // ** create note on server **
    private createNote(note:any) { 
        this.signalk.api.post(`/resources/notes`, note ).subscribe(
            res=> { 
                if(this.reOpen && this.reOpen.key) { 
                    this.showRelatedNotes(this.reOpen.value, this.reOpen.key);
                    this.reOpen= {key: null, value: null}
                } 
                this.getNotes();
            },
            err=> {
                if(err.status && err.status==401) { 
                    this.showAuth().subscribe( res=> {
                        if(res.cancel) { this.authResult(false) }
                        else { // ** authenticate
                            this.signalk.login(res.user, res.pwd).subscribe(
                                r=> {   // ** authenticated
                                    this.authResult(true, r['token']);
                                    this.createNote(note);
                                },
                                err=> {   // ** auth failed
                                    this.authResult(false);
                                    this.showAuth();
                                }
                            );
                        }
                    });
                }  
                else { this.showAlert('ERROR:', 'Server could not add Note!') }                            
            }
        );        
    }
    // ** update note on server **
    private updateNote(id:string, note:any) {
        this.signalk.api.put(`/resources/notes/${id}`, note ).subscribe(
            res=> { 
                if(this.reOpen && this.reOpen.key) { 
                    this.showRelatedNotes(this.reOpen.value, this.reOpen.key);
                    this.reOpen= {key: null, value: null}
                } 
                this.getNotes();
            },
            err=> {
                if(err.status && err.status==401) { 
                    this.showAuth().subscribe( res=> {
                        if(res.cancel) { this.authResult(false) }
                        else { // ** authenticate
                            this.signalk.login(res.user, res.pwd).subscribe(
                                r=> {   // ** authenticated
                                    this.authResult(true, r['token']);
                                    this.updateNote(id, note);
                                },
                                err=> {   // ** auth failed
                                    this.authResult(false);
                                    this.showAuth();
                                }
                            );
                        }
                    });
                } 
                else { this.showAlert('ERROR:', 'Server could not update Note!') }                            
            }
        );        
    } 
    
    // ** delete note on server **
    private deleteNote(id:string) {
        this.signalk.api.delete(`/resources/notes/${id}`)
        .subscribe( 
            r=> {  
                this.getNotes();
                if(r['state']=='COMPLETED') { 
                    this.app.debug('SUCCESS: Note deleted.');
                    if(this.reOpen && this.reOpen.key) { 
                        this.showRelatedNotes(this.reOpen.value, this.reOpen.key);
                        this.reOpen= {key: null, value: null}
                    } 
                }
                else { this.showAlert('ERROR:', 'Server could not delete Note!') }                            
            },
            err=> { 
                if(err.status && err.status==401) { 
                    this.showAuth().subscribe( res=> {
                        if(res.cancel) { this.authResult(false) }
                        else { // ** authenticate
                            this.signalk.login(res.user, res.pwd).subscribe(
                                r=> {   // ** authenticated
                                    this.authResult(true, r['token']);
                                    this.deleteNote(id);
                                },
                                err=> {   // ** auth failed
                                    this.authResult(false);
                                    this.showAuth();
                                }
                            );
                        }
                    });
                }
                else { this.showAlert('ERROR:', 'Server could not delete Note!') }
            }
        );
    }

    // ** Open Note for editing **
    private openNoteForEdit(e:any) {
        this.dialog.open(NoteDialog, {
            disableClose: true,
            data: {
                note: e.note,
                editable: e.editable,
                addNote: e.addNote,
                title: e.title
            }
        }).afterClosed().subscribe( r=> {        
            if(r.result) { // ** save / update waypoint **
                let note= r.data;
                if(e.region) {  // add region + note
                    this.createRegion(e.region, note);
                }
                else if(!e.noteId) { // add note
                    this.createNote(note);
                }
                else {      // update note
                    this.updateNote(e.noteId, note);
                }                    
            }
            else {  // cancel
                if(this.reOpen && this.reOpen.key) { 
                    this.showRelatedNotes(this.reOpen.value, this.reOpen.key);
                    this.reOpen= {key: null, value: null}
                } 
            }
        });
    }

    // ** Show Related Notes dialog **
    showRelatedNotes(id:string, relatedBy:string='region') {
        this.signalk.api.get(`/resources/notes/?${relatedBy}=${id}`).subscribe(
            res=> {
                let notes= this.processNotes(res);
                this.dialog.open(RegionDialog, {
                    disableClose: true,
                    data: { notes: notes }
                }).afterClosed().subscribe( r=> {        
                    if(r.result) { 
                        if(relatedBy) { this.reOpen= {key: relatedBy, value: id} }
                        else { this.reOpen= {key: null, value: null} }
                        switch(r.data) {
                            case 'edit':
                                this.showNoteEditor({id: r.id});
                                break;
                            case 'add':
                                this.showNoteEditor({region: {id: id} });
                                break;
                            case 'delete':
                                this.showNoteDelete({id: r.id});
                                break;
                        }
                    }
                });                
            },
            err=> {
                this.showAlert('ERROR', 'Unable to retrieve Notes for specified Region!');
            }
        );  
    }

    // ** Add / Update Note Dialog
    showNoteEditor(e:any=null) {      
        let note: SKNote;
        let data= {
            noteId: null,
            note: null,
            editable: true,
            addNote: true,
            title: null,
            region: null
        }

        if(!e) { return }
        if(!e.id && e.position) { // add note at provided position
            data.title= 'Add Note:'; 
            note= new SKNote(); 
            note.position= {latitude: e.position[1], longitude: e.position[0]};    
            note.title= '';
            note.description= '';
            data.note= note;
            this.openNoteForEdit(data);
        }
        else if(!e.id && e.region) { // add region + note
            data.title= 'Add Note to Region:'; 
            data.region= e.region; 
            note= new SKNote(); 
            note.region= e.region.id;    
            note.title= '';
            note.description= '';
            data.note= note;
            this.openNoteForEdit(data);
        }        
        else {    // edit selected note details 
            this.signalk.api.get(`/resources/notes/${e.id}`).subscribe(
                res=> {
                    data.noteId= e.id;
                    data.title= 'Edit Note:'; 
                    data.note= res;
                    data.addNote=false;
                    this.openNoteForEdit(data);               
                },
                err=> {
                    this.showAlert('ERROR', 'Unable to retrieve Note!');
                }
            );
        }
        
    }    

    // ** Note info Dialog **
    showNoteInfo(e:any) {
        this.signalk.api.get(`/resources/notes/${e.id}`).subscribe(
            res=> {
                this.dialog.open(NoteDialog, {
                    disableClose: true,
                    data: { note: res, editable: false }
                }).afterClosed().subscribe( r=> {
                    if(r.result) { // ** open in tab **
                        if(r.data== 'url') { window.open(res['url'], 'note') }
                        if(r.data== 'edit') { this.showNoteEditor({id: e.id}) }
                        if(r.data== 'delete') { this.showNoteDelete({id: e.id}) }
                    }
                });  
            },
            err=> {
                this.showAlert('ERROR', 'Unable to retrieve Note!');
            }
        );      
    }

    // ** confirm Note Deletion **
    showNoteDelete(e:any) {
        this.dialog.open(ConfirmDialog, {
            disableClose: true,
            data: {
                message: 'Do you want to delete this Note?\nNote will be removed from the server (if configured to permit this operation).',
                title: 'Delete Note:',
                button1Text: 'YES',
                button2Text: 'NO'
            }
        }).afterClosed().subscribe( ok=> {
            if(ok) { this.deleteNote(e.id) }
            else {
                if(this.reOpen && this.reOpen.key) { 
                    this.showRelatedNotes(this.reOpen.value, this.reOpen.key);
                    this.reOpen= {key: null, value: null}
                }                
            }
        });         
    }

    // *******************************

    // ** alert message **
    private showAlert(title:string, message:string) {
        this.dialog.open(AlertDialog, {
            disableClose: false,
            data: { message: message, title: title }
        });         
    } 

    // ** show login dialog **
    private showAuth(message?:string, cancelWarning:boolean=true, onConnect?:boolean) {
        return this.dialog.open(LoginDialog, {
            disableClose: true,
            data: { message: message || 'Login to Signal K server.'}
        }).afterClosed();             
    }   

    // ** record authentication result state **
    private authResult(ok:boolean=false, token:string=null) {
        this.signalk.authToken= token;
        this.app.db.saveAuthToken(token); 
        this.app.data.hasToken= ok;
    }
    
    // ** process url tokens
    private processTokens(s:string):string {
        if(!s) { return s }
        let ts= s.split('%');
        if(ts.length>1) {
            let uts= ts.map( i=>{
                if(i=='map:latitude') { return this.app.config.map.center[1] }
                else if(i=='map:longitude') { return this.app.config.map.center[0] }
                else { return i }
            });
            s= uts.join('');
        }
        return s;
    }    

}

// **** RESOURCE CLASSES **********

// ** Signal K route
export class SKRoute {
    name: string;
    description: string;
    distance: number= 0;
    start: string;
    end: string;
    feature= {          
        type: 'Feature',
        geometry: {
            type: 'LineString',
            coordinates: [ [0,0], [0,0] ]
        },
        properties: {},
        id: ''
    };

    constructor(route?) {
        if(route) {
            this.name= (route.name) ? route.name : null;
            this.description= (route.description) ? route.description : null;
            this.distance= (route.distance) ? route.distance : null;
            this.start= (route.start) ? route.start : null;
            this.end= (route.end) ? route.end : null;
            this.feature= (route.feature) ? route.feature : null;
        }
    }
}

// ** Signal K waypoint
export class SKWaypoint {
    position= {latitude: 0, longitude: 0};
    feature= {          
        type: 'Feature',
        geometry: {
            type: 'Point',
            coordinates: [0,0]
        },
        properties: {},
        id: ''
    };

    constructor(wpt?) {
        if(wpt) {
            if(wpt.position) { this.position= wpt.position }
            if(wpt.feature) { this.feature= wpt.feature }
        }
    }
} 

// ** Signal K chart
export class SKChart {
    name: string;
    description: string;
    identifier: number;
    tilemapUrl: string;
    region: string;
    geohash: any;
    chartUrl: string;
    scale: number;
    chartLayers: Array<any>;
    bounds: Array<any>;
    chartFormat: string;

    constructor(chart?) {
        if(chart) {
            this.name= (chart.name) ? chart.name : null;
            this.description= (chart.description) ? chart.description : null;
            this.identifier= (chart.identifier) ? chart.identifier : null;
            this.tilemapUrl= (chart.tilemapUrl) ? chart.tilemapUrl : null;
            this.region= (chart.region) ? chart.region : null;
            this.geohash= (chart.geohash) ? chart.geohash : null;
            this.chartUrl= (chart.chartUrl) ? chart.chartUrl : null;
            this.scale= (chart.scale) ? chart.scale : null;
            this.chartLayers= (chart.chartLayers) ? chart.chartLayers : null;
            this.bounds= (chart.bounds) ? chart.bounds : null;
            this.chartFormat= (chart.chartFormat) ? chart.chartFormat : null;
        }
    }
}

// ** Vessel Data **
export class SKVessel {
    id: string;
    position= [0,0];
    heading: number;
    headingTrue: number= 0;
    headingMagnetic: number= 0;
    cog: number;
    cogTrue: number= null;
    cogMagnetic: number= null;
    sog: number;
    name: string;
    mmsi: string;
    callsign: string; 
    state: string;   
    wind= { direction: null, mwd: null, twd: null, tws: null, awa: null, aws: null };
    lastUpdated= new Date();
}

// ** Signal K Note
export class SKNote {
    title: string;
    description: string;
    region: string;
    geohash: string;   
    mimeType: string;
    url: string; 
    position: any;
    timestamp: string;
    source: string; 

    constructor(note?) {
        if(note) {
            if(note.title) { this.title= note.title }
            if(note.description) { this.description= note.description }
            if(note.region) { this.region= note.region }
            if(note.geohash) { this.geohash= note.geohash }
            if(note.mimeType) { this.mimeType= note.mimeType }
            if(note.url) { this.url= note.url }
            if(note.position) { this.position= note.position }
            if(note.timestamp) { this.timestamp= note.timestamp }
            if(note.source) { this.source= note.source }
            if(note.$source) { this.source= note.$source }
        }
    }    
} 

// ** Signal K Region
export class SKRegion {
    geohash: string;   
    feature= {          
        type: 'Feature',
        geometry: {
            type: 'Polygon',
            coordinates: []
        },
        properties: {},
        id: ''
    };

    constructor(region?) {
        if(region) {
            if(region.geohash) { this.geohash= region.geohash }
            if(region.feature) { this.feature= region.feature }
        }
    }     
}